using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Buffer;
using Glimt.Hub.Features.Servers;

namespace Glimt.Hub.Features.Agents;

/// <summary>
/// The one path every agent event takes, whether it came over a WebSocket or from the demo fake agents:
/// session state → ring buffer → subscriptions/log relay → Live projections → alert engine → persistence.
/// </summary>
public sealed class AgentIngest(
    BufferStore buffer,
    SubscriptionCounter subscriptions,
    LogRelay logs,
    ILivePublisher live,
    IServerStore store,
    AlertEngine alerts,
    NodeLinker linker,
    TimeProvider clock,
    ILogger<AgentIngest> logger)
{
    public async Task ConnectedAsync(AgentSession session, bool isNew, CancellationToken cancellationToken)
    {
        await SafeAsync(() => live.StatusAsync(session, cancellationToken), session, "status");
        if (isNew)
        {
            await SafeAsync(() => live.ServerAddedAsync(session, cancellationToken), session, "serverAdded");
        }

        await store.UpsertAsync(session.ToDocument(), cancellationToken);
        await subscriptions.AgentConnectedAsync(session.ServerId, cancellationToken);
        await SafeAsync(() => alerts.ServerUpAsync(session, cancellationToken), session, "alerts");
        if (session.IsContainer && linker.OnNodeConnected(session))
        {
            // A host agent already listed this container: the link is there from the first card.
            await SafeAsync(() => live.StatusAsync(session, cancellationToken), session, "link");
        }
    }

    public async Task DisconnectedAsync(AgentSession session)
    {
        await logs.AgentGoneAsync(session.ServerId, "agent disconnected");
        await SafeAsync(() => live.StatusAsync(session, CancellationToken.None), session, "status");
        await store.TouchAsync(session.ServerId, session.LastSeenAt?.UtcDateTime, session.Status, CancellationToken.None);
    }

    public async Task SnapshotAsync(AgentSession session, Snapshot snapshot, CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        session.StoreSnapshot(snapshot, now);
        buffer.Record(session.ServerId, ToPoint(snapshot, session.RamBytes, now));
        if (!session.IsContainer)
        {
            // A host agent's containers may be container nodes of the same owner (step 12.6): link them, and
            // refresh the cards of the nodes whose link appeared or disappeared.
            foreach (var node in linker.OnHostSnapshot(session, snapshot))
            {
                await SafeAsync(() => live.StatusAsync(node, cancellationToken), node, "link");
            }
        }

        await SafeAsync(() => live.SnapshotAsync(session, cancellationToken), session, "snapshot");
        await SafeAsync(() => alerts.SnapshotAsync(session, snapshot, cancellationToken), session, "alerts");
    }

    public async Task StreamAsync(AgentSession session, Protocol.Stream stream, CancellationToken cancellationToken)
    {
        session.StoreStream(stream, clock.GetUtcNow());
        await SafeAsync(() => live.StreamAsync(session, cancellationToken), session, "stream");
    }

    /// <summary>The agent stops on purpose (SIGTERM in a container): the node sleeps instead of going down (step 12.5).</summary>
    public async Task ByeAsync(AgentSession session, Bye bye, CancellationToken cancellationToken)
    {
        session.MarkSleeping(clock.GetUtcNow());
        logger.LogInformation("node {ServerId} ({Name}) says bye ({Reason}); sleeping", session.ServerId, session.Name, bye.Reason);
        await logs.AgentGoneAsync(session.ServerId, "agent stopped");
        await SafeAsync(() => live.StatusAsync(session, cancellationToken), session, "status");
        await store.TouchAsync(session.ServerId, session.LastSeenAt?.UtcDateTime, session.Status, cancellationToken);
    }

    public Task LogAsync(AgentSession session, Log log, CancellationToken cancellationToken) =>
        logs.OnLogAsync(session.ServerId, log, cancellationToken);

    public Task LogEndAsync(AgentSession session, LogEnd end, CancellationToken cancellationToken) =>
        logs.OnLogEndAsync(session.ServerId, end, cancellationToken);

    /// <summary>Agent clocks may be off; a ts more than 5 minutes from the hub's clock is replaced by the hub's.</summary>
    public static readonly TimeSpan MaxClockSkew = TimeSpan.FromMinutes(5);

    /// <summary>The buffer point for one snapshot: percentages plus byte rates per interface (IMPLEMENTERINGSPLAN 4.5).</summary>
    public static PointInput ToPoint(Snapshot snapshot, long hostRamBytes, DateTimeOffset now)
    {
        var nowMs = now.ToUnixTimeMilliseconds();
        var ts = Math.Abs(nowMs - snapshot.Ts) > MaxClockSkew.TotalMilliseconds ? nowMs : snapshot.Ts;
        var host = snapshot.Host;
        var mem = host.Mem;
        var memTotal = mem.Total > 0 ? mem.Total : hostRamBytes;
        var disks = new List<DiskInput>();
        foreach (var mount in host.Mounts ?? [])
        {
            disks.Add(new DiskInput(mount.Path, Pct(mount.Used, mount.Total)));
        }

        var ifaces = new List<IfaceInput>();
        foreach (var iface in host.Ifaces ?? [])
        {
            ifaces.Add(new IfaceInput(iface.Name, (float)(iface.RxBps ?? 0), (float)(iface.TxBps ?? 0)));
        }

        var containers = new List<ContainerInput>();
        foreach (var c in snapshot.Containers ?? [])
        {
            var limit = c.MemLimit is > 0 ? c.MemLimit.Value : memTotal;
            containers.Add(new ContainerInput(c.Id, (float)(c.CpuPct ?? 0), Pct(c.MemBytes ?? 0, limit)));
        }

        return new PointInput(
            ts,
            (float)host.Cpu.Total,
            Pct(mem.Used, memTotal),
            Pct(mem.SwapUsed ?? 0, mem.SwapTotal ?? 0),
            disks,
            ifaces,
            containers);
    }

    private static float Pct(long part, long total) => total > 0 ? (float)Math.Clamp(part * 100.0 / total, 0, 100) : 0f;

    private async Task SafeAsync(Func<Task> action, AgentSession session, string what)
    {
        try
        {
            await action();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("{What} for {ServerId} failed: {Error}", what, session.ServerId, ex.Message);
        }
    }
}
