using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Buffer;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Demo;

/// <summary>
/// Demo mode: 16 simulated servers (design/glimtData.js) owned by demo@glimtpanel.com, fed straight into
/// the registry, buffer and Live projections without a WebSocket: stream every second, snapshot every
/// 30 s, 24 h of history at start. In e2e the numbers are seeded and the /api/e2e/* endpoints mutate them.
/// </summary>
public sealed class FakeAgentService(
    AgentRegistry registry,
    AgentIngest ingest,
    BufferStore buffers,
    UserDirectory users,
    IServerStore store,
    IEnrolKeyStore enrolKeys,
    MongoContext mongo,
    GlimtOptions options,
    TimeProvider clock,
    ILogger<FakeAgentService> logger) : BackgroundService
{
    public const int E2eSeed = 20260909;
    public const string FallbackDemoUserId = "demo-user";
    /// <summary>Hostname of the server POST /api/e2e/enrol-fake-agent creates when none is given (screen 3 in the design).</summary>
    public const string DefaultEnrolHostname = "web-03";
    private static readonly TimeSpan MongoWait = TimeSpan.FromSeconds(5);

    private readonly Lock _lock = new();
    private readonly List<FakeServer> _servers = [];
    private readonly Dictionary<string, FakeAgentLink> _links = new(StringComparer.Ordinal);
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Random _rng = new();

    /// <summary>Completes once the 16 servers are in the registry with history and a first snapshot.</summary>
    public Task Ready => _ready.Task;

    public string DemoUserId { get; private set; } = FallbackDemoUserId;

    /// <summary>The user that owns the 16 demo servers (the dev user in e2e when it exists, otherwise the demo user).</summary>
    public string OwnerId { get; private set; } = FallbackDemoUserId;

    public IReadOnlyList<FakeServer> Servers
    {
        get
        {
            lock (_lock)
            {
                return _servers.ToArray();
            }
        }
    }

    public FakeServer? Find(string? serverId)
    {
        lock (_lock)
        {
            if (string.IsNullOrEmpty(serverId))
            {
                return _servers.FirstOrDefault();
            }

            return _servers.FirstOrDefault(s => s.ServerId == serverId || s.Name == serverId);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var ownerId = await ResolveOwnerAsync(stoppingToken);
            OwnerId = ownerId;
            _rng = options.Env == GlimtOptions.E2e ? new Random(E2eSeed) : new Random();
            var now = clock.GetUtcNow();
            for (var i = 0; i < DemoData.Definitions.Length; i++)
            {
                var fake = new FakeServer(i, DemoData.Definitions[i], _rng, now);
                lock (_lock)
                {
                    _servers.Add(fake);
                }

                await StartServerAsync(fake, ownerId, now, stoppingToken);
            }

            logger.LogInformation("demo mode: {Count} fake servers started (owner {OwnerId}, seed {Seed})", _servers.Count, ownerId, options.Env == GlimtOptions.E2e ? E2eSeed : "random");
            _ready.TrySetResult();
            await LoopAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "demo mode failed");
            _ready.TrySetException(ex);
        }
    }

    /// <summary>The demo user (created when MongoDB is there); in e2e the dev user owns the servers when it exists.</summary>
    private async Task<string> ResolveOwnerAsync(CancellationToken cancellationToken)
    {
        var available = false;
        try
        {
            available = await mongo.Ready.WaitAsync(MongoWait, cancellationToken);
        }
        catch (TimeoutException)
        {
            logger.LogWarning("demo mode: MongoDB did not answer within {Seconds} s; demo servers stay in memory", MongoWait.TotalSeconds);
        }

        if (!available)
        {
            return DemoUserId;
        }

        DemoUserId = await users.EnsureUserAsync(DemoData.DemoUserEmail, "Demo", cancellationToken) ?? FallbackDemoUserId;
        if (options.Env != GlimtOptions.E2e)
        {
            return DemoUserId;
        }

        // The dev seeder runs concurrently; give it a few seconds.
        for (var attempt = 0; attempt < 10; attempt++)
        {
            if (await users.DevUserIdAsync(cancellationToken) is { } dev)
            {
                return dev;
            }

            await Task.Delay(500, cancellationToken);
        }

        return DemoUserId;
    }

    private async Task StartServerAsync(FakeServer fake, string ownerId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var session = registry.GetOrAddDemo(fake.ServerId);
        session.SetIdentity(fake.Name, fake.Definition.Tags);
        session.OwnerId = ownerId;
        var link = new FakeAgentLink(fake, this);
        lock (_lock)
        {
            _links[fake.ServerId] = link;
        }

        var downAt = fake.Definition.Flags.DownAt is { } at ? TodayAt(at, now) : (DateTimeOffset?)null;
        FillHistory(fake, now, downAt);

        session.Attach(link, fake.Hello(), now);
        if (downAt is { } down)
        {
            session.Detach(link.ConnectionId);
            session.MarkDown(down);
            await store.UpsertAsync(session.ToDocument(), cancellationToken);
            return;
        }

        await ingest.ConnectedAsync(session, isNew: true, cancellationToken);
        await ingest.SnapshotAsync(session, fake.Snapshot(now.ToUnixTimeMilliseconds()), cancellationToken);
    }

    private void FillHistory(FakeServer fake, DateTimeOffset now, DateTimeOffset? until)
    {
        const int n = ServerBuffer.Capacity;
        var step = HistoryQuery.Step1hMs;
        var end = now.ToUnixTimeMilliseconds() / step * step;
        var stop = until?.ToUnixTimeMilliseconds() ?? long.MaxValue;
        for (var i = 0; i < n; i++)
        {
            var ts = end - (n - 1 - i) * step;
            if (ts >= stop)
            {
                break;
            }

            buffers.Record(fake.ServerId, fake.HistoryPoint(i, n, ts));
        }
    }

    private async Task LoopAsync(CancellationToken cancellationToken)
    {
        var tick = 0;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            tick++;
            var snapshot = tick % 30 == 0;
            var ts = clock.GetUtcNow().ToUnixTimeMilliseconds();
            foreach (var fake in Servers)
            {
                if (!fake.Online || !registry.TryGet(fake.ServerId, out var session) || !session.Connected)
                {
                    continue;
                }

                fake.Tick();
                await ingest.StreamAsync(session, fake.Stream(ts), cancellationToken);
                if (snapshot)
                {
                    await ingest.SnapshotAsync(session, fake.Snapshot(ts), cancellationToken);
                }
            }
        }
    }

    // ---- e2e controls ----------------------------------------------------------------------------

    public async Task<bool> DisconnectAsync(string? serverId, CancellationToken cancellationToken)
    {
        if (Find(serverId) is not { } fake || !registry.TryGet(fake.ServerId, out var session))
        {
            return false;
        }

        fake.Online = false;
        if (session.Detach(Link(fake).ConnectionId))
        {
            await ingest.DisconnectedAsync(session);
        }

        return true;
    }

    public async Task<bool> ReconnectAsync(string? serverId, CancellationToken cancellationToken)
    {
        if (Find(serverId) is not { } fake || !registry.TryGet(fake.ServerId, out var session))
        {
            return false;
        }

        fake.Online = true;
        session.Attach(Link(fake), fake.Hello(), clock.GetUtcNow());
        await ingest.ConnectedAsync(session, isNew: false, cancellationToken);
        await ingest.SnapshotAsync(session, fake.Snapshot(clock.GetUtcNow().ToUnixTimeMilliseconds()), cancellationToken);
        return true;
    }

    public async Task<bool> FailServiceAsync(string? serverId, string? unit, CancellationToken cancellationToken)
    {
        if (Find(serverId) is not { } fake || !registry.TryGet(fake.ServerId, out var session))
        {
            return false;
        }

        unit = string.IsNullOrWhiteSpace(unit) ? "cron-sync.service" : unit;
        if (!fake.FailedUnits.Contains(unit))
        {
            fake.FailedUnits.Add(unit);
        }

        if (session.Connected)
        {
            await ingest.SnapshotAsync(session, fake.Snapshot(clock.GetUtcNow().ToUnixTimeMilliseconds()), cancellationToken);
        }

        return true;
    }

    /// <summary>
    /// POST /api/e2e/enrol-fake-agent: consumes a real one-time key (POST /api/servers/enrol-key) exactly like an
    /// agent's hello would, and starts a new fake server owned by the key's owner. The overview sees
    /// ServerAdded and the "Add server" dialog jumps to step 2 (IMPLEMENTERINGSPLAN step 4.3). The server has no
    /// history, like a freshly installed agent.
    /// </summary>
    public async Task<EnrolFakeResult> EnrolAsync(string? key, string? hostname, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return EnrolFakeResult.Fail(StatusCodes.Status400BadRequest, "key is required");
        }

        var name = ServerIds.Slug(string.IsNullOrWhiteSpace(hostname) ? DefaultEnrolHostname : hostname);
        lock (_lock)
        {
            if (_servers.Any(s => s.Name == name))
            {
                return EnrolFakeResult.Fail(StatusCodes.Status409Conflict, $"a fake server named {name} already exists");
            }
        }

        var info = await enrolKeys.TryConsumeAsync(key, cancellationToken);
        if (info is null)
        {
            return EnrolFakeResult.Fail(StatusCodes.Status404NotFound, "unknown, expired or already used key");
        }

        var now = clock.GetUtcNow();
        var definition = new DemoDefinition(name, [], 2, 4, "24.04", 22, 46, [new DemoMount("/", "ext4", 40, 37)], 3, new DemoFlags());
        FakeServer fake;
        lock (_lock)
        {
            // Own Random: the shared one is used by the tick loop on another thread.
            fake = new FakeServer(_servers.Count % DemoData.Definitions.Length, definition, new Random(), now) { DockerMode = info.DockerMode };
            _servers.Add(fake);
        }

        var session = registry.GetOrAddDemo(fake.ServerId);
        session.OwnerId = info.OwnerId;
        var link = new FakeAgentLink(fake, this);
        lock (_lock)
        {
            _links[fake.ServerId] = link;
        }

        // No SetIdentity: the name comes from the hostname in hello, as for a real enrolment.
        session.Attach(link, fake.Hello(), now);
        await ingest.ConnectedAsync(session, isNew: true, cancellationToken);
        await ingest.SnapshotAsync(session, fake.Snapshot(now.ToUnixTimeMilliseconds()), cancellationToken);
        logger.LogInformation("e2e: fake agent {Name} enrolled as {ServerId} for owner {OwnerId}", name, fake.ServerId, info.OwnerId);
        return EnrolFakeResult.Ok(fake.ServerId, name, info.OwnerId);
    }

    // ---- fake agent side -------------------------------------------------------------------------

    internal Task EmitLogAsync(FakeServer fake, Log log, CancellationToken cancellationToken) =>
        registry.TryGet(fake.ServerId, out var session) ? ingest.LogAsync(session, log, cancellationToken) : Task.CompletedTask;

    internal Task EmitLogEndAsync(FakeServer fake, LogEnd end) =>
        registry.TryGet(fake.ServerId, out var session) ? ingest.LogEndAsync(session, end, CancellationToken.None) : Task.CompletedTask;

    internal long NowMs => clock.GetUtcNow().ToUnixTimeMilliseconds();

    private FakeAgentLink Link(FakeServer fake)
    {
        lock (_lock)
        {
            return _links[fake.ServerId];
        }
    }

    /// <summary>"03:12" today in the hub's local time zone (yesterday when that is still ahead of now).</summary>
    internal static DateTimeOffset TodayAt(string hhmm, DateTimeOffset now)
    {
        var parts = hhmm.Split(':');
        var local = TimeZoneInfo.ConvertTime(now, TimeZoneInfo.Local);
        var at = new DateTimeOffset(local.Year, local.Month, local.Day, int.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture), int.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture), 0, local.Offset);
        return at > now ? at.AddDays(-1) : at;
    }
}

/// <summary>Outcome of <see cref="FakeAgentService.EnrolAsync"/>: the new server, or an HTTP status with a reason.</summary>
public sealed record EnrolFakeResult(int Status, string? ServerId, string? Name, string? OwnerId, string? Error)
{
    public static EnrolFakeResult Ok(string serverId, string name, string ownerId) => new(StatusCodes.Status200OK, serverId, name, ownerId, null);

    public static EnrolFakeResult Fail(int status, string error) => new(status, null, null, null, error);
}

/// <summary>
/// The "socket" of a fake server: subscribe/unsubscribe/rotate/ping are accepted silently (the service
/// streams anyway); logStart produces lines from the demo tables at one per second until logStop.
/// </summary>
internal sealed class FakeAgentLink(FakeServer fake, FakeAgentService service) : IAgentLink
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, CancellationTokenSource> _streams = new(StringComparer.Ordinal);

    public string ConnectionId { get; } = "demo-" + fake.Name;

    public Task SendAsync(AgentMessage message, CancellationToken cancellationToken = default)
    {
        switch (message)
        {
            case LogStart start:
                Start(start);
                break;
            case LogStop stop:
                Stop(stop.StreamId);
                break;
        }

        return Task.CompletedTask;
    }

    public Task CloseAsync(string reason, CancellationToken cancellationToken = default)
    {
        lock (_lock)
        {
            foreach (var cts in _streams.Values)
            {
                cts.Cancel();
            }

            _streams.Clear();
        }

        return Task.CompletedTask;
    }

    private void Start(LogStart start)
    {
        var cts = new CancellationTokenSource();
        lock (_lock)
        {
            if (_streams.Remove(start.StreamId, out var old))
            {
                old.Cancel();
            }

            _streams[start.StreamId] = cts;
        }

        _ = Task.Run(() => RunAsync(start, cts.Token));
    }

    private void Stop(string streamId)
    {
        lock (_lock)
        {
            if (_streams.Remove(streamId, out var cts))
            {
                cts.Cancel();
            }
        }
    }

    private async Task RunAsync(LogStart start, CancellationToken cancellationToken)
    {
        var reason = LogEndReasons.Stopped;
        try
        {
            var tail = Math.Min(start.Tail ?? LogRelay.DefaultTail, 30);
            var backlog = fake.LogLines(start, service.NowMs - tail * 1000, tail).ToList();
            if (backlog.Count > 0)
            {
                await service.EmitLogAsync(fake, new Log(start.StreamId, null, backlog), cancellationToken);
            }

            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            var i = tail;
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                var line = fake.LogLines(start, service.NowMs, i + 1).Skip(i++).FirstOrDefault();
                if (line is null)
                {
                    reason = LogEndReasons.Eof;
                    break;
                }

                await service.EmitLogAsync(fake, new Log(start.StreamId, null, [line with { Ts = service.NowMs }]), cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // stopped
        }
        finally
        {
            lock (_lock)
            {
                _streams.Remove(start.StreamId);
            }

            await service.EmitLogEndAsync(fake, new LogEnd(start.StreamId, reason, null));
        }
    }
}
