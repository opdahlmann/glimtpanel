using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Alerts.Channels;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace Glimt.Hub.Tests;

/// <summary>An alert store in memory, so the engine can be tested without MongoDB.</summary>
public sealed class InMemoryAlertStore : IAlertStore
{
    public List<AlertDocument> Alerts { get; } = [];

    public Dictionary<string, AlertSettingsDocument> Settings { get; } = new(StringComparer.Ordinal);

    public List<PushSubscriptionDocument> Subscriptions { get; } = [];

    public Task InsertAsync(AlertDocument alert, CancellationToken cancellationToken)
    {
        Alerts.Add(alert);
        return Task.CompletedTask;
    }

    public Task ResolveAsync(string alertId, DateTime resolvedAt, CancellationToken cancellationToken)
    {
        var alert = Alerts.Single(a => a.Id == alertId);
        alert.State = AlertStates.Resolved;
        alert.ResolvedAt = resolvedAt;
        return Task.CompletedTask;
    }

    public Task SetReminderAsync(string alertId, DateTime at, CancellationToken cancellationToken)
    {
        Alerts.Single(a => a.Id == alertId).LastReminderAt = at;
        return Task.CompletedTask;
    }

    public Task AddNotifiedViaAsync(string alertId, string channel, CancellationToken cancellationToken)
    {
        var alert = Alerts.SingleOrDefault(a => a.Id == alertId);
        if (alert is not null && !alert.NotifiedVia.Contains(channel))
        {
            alert.NotifiedVia.Add(channel);
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<AlertDocument>> ListFiringAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<AlertDocument>>(Alerts.Where(a => a.State == AlertStates.Firing).ToList());

    public Task<IReadOnlyList<AlertDocument>> ListByServersAsync(IReadOnlyCollection<string> serverIds, string? state, int limit, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<AlertDocument>>(Alerts.Where(a => serverIds.Contains(a.ServerId) && (state is null || a.State == state)).OrderByDescending(a => a.FiredAt).Take(limit).ToList());

    public Task<IReadOnlyList<AlertDocument>> ListFiredSinceAsync(IReadOnlyCollection<string> serverIds, DateTime since, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<AlertDocument>>(Alerts.Where(a => serverIds.Contains(a.ServerId) && a.FiredAt >= since).OrderBy(a => a.FiredAt).ToList());

    public Task DeleteByServerAsync(string serverId, CancellationToken cancellationToken)
    {
        Alerts.RemoveAll(a => a.ServerId == serverId);
        return Task.CompletedTask;
    }

    public Task<AlertSettingsDocument?> GetSettingsAsync(string userId, CancellationToken cancellationToken) =>
        Task.FromResult(Settings.GetValueOrDefault(userId));

    public Task UpsertSettingsAsync(AlertSettingsDocument settings, CancellationToken cancellationToken)
    {
        Settings[settings.UserId] = settings;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<AlertSettingsDocument>> ListSettingsAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<AlertSettingsDocument>>(Settings.Values.ToList());

    public Task SetLastDigestDateAsync(string userId, string localDate, CancellationToken cancellationToken)
    {
        if (!Settings.TryGetValue(userId, out var settings))
        {
            settings = AlertSettingsDocument.Defaults(userId);
            Settings[userId] = settings;
        }

        settings.LastDigestDate = localDate;
        return Task.CompletedTask;
    }

    public Task UpsertSubscriptionAsync(PushSubscriptionDocument subscription, CancellationToken cancellationToken)
    {
        Subscriptions.RemoveAll(s => s.Endpoint == subscription.Endpoint);
        Subscriptions.Add(subscription);
        return Task.CompletedTask;
    }

    public Task<bool> DeleteSubscriptionAsync(string userId, string endpoint, CancellationToken cancellationToken) =>
        Task.FromResult(Subscriptions.RemoveAll(s => s.UserId == userId && s.Endpoint == endpoint) > 0);

    public Task DeleteSubscriptionByEndpointAsync(string endpoint, CancellationToken cancellationToken)
    {
        Subscriptions.RemoveAll(s => s.Endpoint == endpoint);
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<PushSubscriptionDocument>> ListSubscriptionsAsync(IReadOnlyCollection<string> userIds, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<PushSubscriptionDocument>>(Subscriptions.Where(s => userIds.Contains(s.UserId)).ToList());
}

/// <summary>Records every engine event.</summary>
public sealed class RecordingAlertSink : IAlertSink
{
    public ConcurrentQueue<AlertEvent> Events { get; } = new();

    public Task OnAlertAsync(AlertEvent alertEvent, CancellationToken cancellationToken)
    {
        Events.Enqueue(alertEvent);
        return Task.CompletedTask;
    }

    public AlertEvent[] OfKind(string kind) => Events.Where(e => e.Kind == kind).ToArray();

    public AlertEvent Last => Events.Last();
}

/// <summary>Records what the dispatcher hands to a channel (registered instead of the real channels in the endpoint tests).</summary>
public sealed class FakeChannel(string name) : IChannel
{
    public string Name { get; } = name;

    public ConcurrentQueue<AlertNotification> Sent { get; } = new();

    public Task<bool> SendAsync(AlertNotification notification, CancellationToken cancellationToken)
    {
        Sent.Enqueue(notification);
        return Task.FromResult(true);
    }
}

/// <summary>A server store that only knows what the test puts in it (no MongoDB).</summary>
public sealed class InMemoryServerStore : IServerStore
{
    public Dictionary<string, ServerDocument> Docs { get; } = new(StringComparer.Ordinal);

    public Task<ServerDocument?> FindByTokenHashAsync(string tokenHash, CancellationToken cancellationToken) => Task.FromResult(Docs.Values.FirstOrDefault(d => d.TokenHash == tokenHash));

    public Task UpsertAsync(ServerDocument doc, CancellationToken cancellationToken)
    {
        Docs[doc.Id] = doc;
        return Task.CompletedTask;
    }

    public Task TouchAsync(string serverId, DateTime? lastSeenAt, string status, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<ServerDocument?> FindAsync(string serverId, CancellationToken cancellationToken) => Task.FromResult(Docs.GetValueOrDefault(serverId));

    public Task<IReadOnlyList<ServerDocument>> ListByIdsAsync(IEnumerable<string> serverIds, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<ServerDocument>>(serverIds.Where(Docs.ContainsKey).Select(id => Docs[id]).ToList());

    public Task<IReadOnlyList<ServerDocument>> ListByOwnersAsync(IEnumerable<string> ownerIds, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<ServerDocument>>(Docs.Values.Where(d => ownerIds.Contains(d.OwnerId)).ToList());

    public Task<IReadOnlyList<ServerDocument>> ListOwnerlessAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<ServerDocument>>(Docs.Values.Where(d => d.OwnerId is null).ToList());

    public Task<long> CountByOwnerAsync(string ownerId, CancellationToken cancellationToken) => Task.FromResult((long)Docs.Values.Count(d => d.OwnerId == ownerId));

    public Task<ServerDocument?> UpdateNameTagsAsync(string serverId, string? name, IReadOnlyList<string>? tags, CancellationToken cancellationToken) => FindAsync(serverId, cancellationToken);

    public Task<bool> DeleteAsync(string serverId, CancellationToken cancellationToken) => Task.FromResult(Docs.Remove(serverId));

    public Task<bool> RotateTokenAsync(string serverId, string newTokenHash, DateTime previousTokenValidUntil, CancellationToken cancellationToken) => Task.FromResult(Docs.ContainsKey(serverId));

    public Task<bool> SilenceAsync(string serverId, DateTime? until, CancellationToken cancellationToken)
    {
        if (!Docs.TryGetValue(serverId, out var doc))
        {
            return Task.FromResult(false);
        }

        doc.SilencedUntil = until;
        return Task.FromResult(true);
    }

    public Task<ServerDocument?> UpdateAlertSettingsAsync(string serverId, Dictionary<string, RuleSettingDocument>? overrides, bool? muted, bool clearSilence, CancellationToken cancellationToken)
    {
        if (!Docs.TryGetValue(serverId, out var doc))
        {
            return Task.FromResult<ServerDocument?>(null);
        }

        if (overrides is not null)
        {
            doc.AlertOverrides = overrides.Count == 0 ? null : overrides;
        }

        if (muted is { } m)
        {
            doc.AlertsMuted = m;
        }

        if (clearSilence)
        {
            doc.SilencedUntil = null;
        }

        return Task.FromResult<ServerDocument?>(doc);
    }
}

/// <summary>The one owner the harness knows, in UTC so "last seen HH:mm" is predictable.</summary>
internal sealed class OwnerLookup : IUserLookup
{
    public Task<IReadOnlyList<UserDocument>> FindByIdsAsync(IEnumerable<string> ids, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<UserDocument>>(ids.Contains(AlertEngineHarness.OwnerId)
            ? [new UserDocument { Id = AlertEngineHarness.OwnerId, Email = "owner@test.local", Name = "Owner", Timezone = "UTC", Language = "en" }]
            : []);
}

internal sealed class NullAgentLink(string id = "test-link") : IAgentLink
{
    public string ConnectionId { get; } = id;

    public Task SendAsync(AgentMessage message, CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task CloseAsync(string reason, CancellationToken cancellationToken = default) => Task.CompletedTask;
}

/// <summary>
/// An engine wired to fakes: in-memory stores, a recording sink and a FakeTimeProvider. Servers are owned by
/// <see cref="OwnerId"/> (in the in-memory server store), so overrides, silence and mute can be set per test.
/// </summary>
public sealed class AlertEngineHarness
{
    public const string OwnerId = "owner-1";

    public AlertEngineHarness(DateTimeOffset? start = null)
    {
        Clock = new FakeTimeProvider(start ?? new DateTimeOffset(2026, 9, 14, 8, 0, 0, TimeSpan.Zero));
        var options = new GlimtOptions
        {
            Env = GlimtOptions.E2e,
            MongoUri = HubFactory.UnreachableMongoUri,
            MongoDb = "test",
            JwtSecret = "test",
            HubUrl = "http://localhost:5080",
        };
        var mongo = new MongoContext(options, NullLogger<MongoContext>.Instance);
        var directory = new UserDirectory(mongo, options, Clock, NullLogger<UserDirectory>.Instance);
        Config = new AlertConfigProvider(Servers, Store, new OwnerLookup(), directory, Clock, NullLogger<AlertConfigProvider>.Instance);
        Engine = new AlertEngine(Store, Config, Counts, Registry, [Sink], Clock, NullLogger<AlertEngine>.Instance);
    }

    public FakeTimeProvider Clock { get; }

    public InMemoryAlertStore Store { get; } = new();

    public InMemoryServerStore Servers { get; } = new();

    public RecordingAlertSink Sink { get; } = new();

    public ActiveAlertCounts Counts { get; } = new();

    public AgentRegistry Registry { get; } = new();

    public AlertConfigProvider Config { get; }

    public AlertEngine Engine { get; }

    /// <summary>A connected server in the registry and the store, owned by <see cref="OwnerId"/>.</summary>
    public AgentSession Server(string id, string name)
    {
        var session = Registry.GetOrAdd(id);
        session.OwnerId = OwnerId;
        session.SetIdentity(name, []);
        session.Attach(new NullAgentLink("link-" + id), Hello(name), Clock.GetUtcNow());
        Servers.Docs[id] = new ServerDocument { Id = id, OwnerId = OwnerId, Name = name, Hostname = name, CreatedAt = Clock.GetUtcNow().UtcDateTime };
        return session;
    }

    public static Hello Hello(string hostname) => new(1, null, null, hostname, "0.1.0", new OsInfo("ubuntu", "24.04", "Ubuntu 24.04"), "6.8", "amd64", 4, 8L << 30, 0, "none");

    /// <summary>The protocol example snapshot, with the fields a test wants changed. Disk is 92 % on / by default (disk_full fires at once).</summary>
    public static Snapshot Snapshot(double? cpu = null, double? memPct = null, double? diskPct = null, bool? reboot = null, IEnumerable<string>? failedUnits = null, IEnumerable<JsonObject>? containers = null)
    {
        var json = Repo.Example("snapshot").AsObject();
        var host = json["host"]!.AsObject();
        if (cpu is { } c)
        {
            host["cpu"]!["total"] = c;
        }

        if (memPct is { } m)
        {
            var total = host["mem"]!["total"]!.GetValue<long>();
            host["mem"]!["used"] = (long)(total * m / 100);
        }

        if (diskPct is { } d)
        {
            foreach (var mount in host["mounts"]!.AsArray())
            {
                var total = mount!["total"]!.GetValue<long>();
                mount["used"] = (long)(total * d / 100);
            }
        }

        // The example snapshot says reboot required and has one container; the tests opt in to both.
        json["maintenance"]!["rebootRequired"] = reboot ?? false;

        if (failedUnits is not null)
        {
            var units = new JsonArray(failedUnits.Select(u => (JsonNode?)new JsonObject { ["name"] = u, ["state"] = "failed" }).ToArray());
            json["services"] = new JsonObject { ["units"] = units, ["failed"] = new JsonArray(failedUnits.Select(u => (JsonNode?)u).ToArray()) };
        }
        else
        {
            json["services"] = new JsonObject { ["units"] = new JsonArray(), ["failed"] = new JsonArray() };
        }

        json["containers"] = new JsonArray((containers ?? []).Select(c => (JsonNode?)c).ToArray());

        return JsonSerializer.Deserialize<Snapshot>(json.ToJsonString(), ProtocolJson.Options)!;
    }

    public static JsonObject Container(string name, string state, int restarts) => new()
    {
        ["id"] = "id-" + name,
        ["name"] = name,
        ["image"] = "nginx:1.27",
        ["state"] = state,
        ["restartCount"] = restarts,
    };

    /// <summary>Feeds a snapshot at the current clock and advances by 30 s (the heartbeat).</summary>
    public async Task TickAsync(AgentSession session, Snapshot snapshot, int seconds = 30)
    {
        await Engine.SnapshotAsync(session, snapshot, CancellationToken.None);
        Clock.Advance(TimeSpan.FromSeconds(seconds));
    }
}
