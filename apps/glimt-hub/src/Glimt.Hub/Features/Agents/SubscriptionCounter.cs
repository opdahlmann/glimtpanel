using Glimt.Hub.Features.Agents.Protocol;

namespace Glimt.Hub.Features.Agents;

/// <summary>
/// Counts browser connections per server across overview and server-page subscriptions and drives the
/// agent's stream: 0→1 sends subscribe with the lowest interval among the subscribers, a changed minimum
/// sends subscribe again, 1→0 sends unsubscribe (IMPLEMENTERINGSPLAN 4.3, step 2.7).
/// </summary>
public sealed class SubscriptionCounter(AgentRegistry registry, ILogger<SubscriptionCounter> logger)
{
    public const int DefaultIntervalMs = 1000;
    public const int TopProcs = 40;
    public static readonly int[] AllowedIntervals = [1000, 5000];

    private readonly Lock _lock = new();
    private readonly Dictionary<string, ConnectionSubscriptions> _connections = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<string>> _byServer = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _sentInterval = new(StringComparer.Ordinal);

    private sealed class ConnectionSubscriptions
    {
        public int IntervalMs = DefaultIntervalMs;
        public readonly HashSet<string> Overview = new(StringComparer.Ordinal);
        public readonly HashSet<string> Servers = new(StringComparer.Ordinal);

        public bool Watches(string serverId) => Overview.Contains(serverId) || Servers.Contains(serverId);
    }

    public int SubscriberCount(string serverId)
    {
        lock (_lock)
        {
            return _byServer.TryGetValue(serverId, out var set) ? set.Count : 0;
        }
    }

    /// <summary>The interval last sent to the agent, or null when unsubscribed.</summary>
    public int? CurrentInterval(string serverId)
    {
        lock (_lock)
        {
            return _sentInterval.TryGetValue(serverId, out var ms) ? ms : null;
        }
    }

    public Task SubscribeServerAsync(string connectionId, string serverId, CancellationToken cancellationToken) =>
        ChangeAsync(connectionId, c => c.Servers.Add(serverId), [serverId], cancellationToken);

    public Task UnsubscribeServerAsync(string connectionId, string serverId, CancellationToken cancellationToken) =>
        ChangeAsync(connectionId, c => c.Servers.Remove(serverId), [serverId], cancellationToken);

    public Task SubscribeOverviewAsync(string connectionId, IEnumerable<string> serverIds, CancellationToken cancellationToken)
    {
        var ids = serverIds.ToArray();
        return ChangeAsync(connectionId, c => c.Overview.UnionWith(ids), ids, cancellationToken);
    }

    public Task UnsubscribeOverviewAsync(string connectionId, CancellationToken cancellationToken)
    {
        string[] affected;
        lock (_lock)
        {
            affected = _connections.TryGetValue(connectionId, out var c) ? c.Overview.ToArray() : [];
        }

        return ChangeAsync(connectionId, c => c.Overview.Clear(), affected, cancellationToken);
    }

    /// <summary>The connection is gone: every subscription it held is dropped.</summary>
    public Task RemoveConnectionAsync(string connectionId, CancellationToken cancellationToken)
    {
        string[] affected;
        lock (_lock)
        {
            if (!_connections.Remove(connectionId, out var c))
            {
                return Task.CompletedTask;
            }

            affected = c.Overview.Union(c.Servers).ToArray();
        }

        return ReconcileAsync(affected, cancellationToken);
    }

    /// <summary>Only 1000 or 5000 (IMPLEMENTERINGSPLAN 4.3).</summary>
    public Task SetIntervalAsync(string connectionId, int intervalMs, CancellationToken cancellationToken)
    {
        if (!AllowedIntervals.Contains(intervalMs))
        {
            throw new ArgumentOutOfRangeException(nameof(intervalMs), intervalMs, "interval must be 1000 or 5000");
        }

        string[] affected;
        lock (_lock)
        {
            var c = Get(connectionId);
            c.IntervalMs = intervalMs;
            affected = c.Overview.Union(c.Servers).ToArray();
        }

        return ReconcileAsync(affected, cancellationToken);
    }

    /// <summary>The agent (re)connected: it starts unsubscribed, so a wanted stream is requested again.</summary>
    public Task AgentConnectedAsync(string serverId, CancellationToken cancellationToken)
    {
        lock (_lock)
        {
            _sentInterval.Remove(serverId);
        }

        return ReconcileAsync([serverId], cancellationToken);
    }

    public void Forget(string serverId)
    {
        lock (_lock)
        {
            _byServer.Remove(serverId);
            _sentInterval.Remove(serverId);
            foreach (var c in _connections.Values)
            {
                c.Overview.Remove(serverId);
                c.Servers.Remove(serverId);
            }
        }
    }

    private Task ChangeAsync(string connectionId, Action<ConnectionSubscriptions> change, string[] affected, CancellationToken cancellationToken)
    {
        lock (_lock)
        {
            change(Get(connectionId));
        }

        return ReconcileAsync(affected, cancellationToken);
    }

    private ConnectionSubscriptions Get(string connectionId)
    {
        if (!_connections.TryGetValue(connectionId, out var c))
        {
            c = new ConnectionSubscriptions();
            _connections[connectionId] = c;
        }

        return c;
    }

    /// <summary>Recomputes subscriber sets and minimum intervals for the servers and tells the agents about changes.</summary>
    private async Task ReconcileAsync(string[] serverIds, CancellationToken cancellationToken)
    {
        var sends = new List<(string ServerId, AgentMessage Message)>();
        lock (_lock)
        {
            foreach (var serverId in serverIds.Distinct())
            {
                var watchers = new HashSet<string>(StringComparer.Ordinal);
                int? min = null;
                foreach (var (connectionId, c) in _connections)
                {
                    if (!c.Watches(serverId))
                    {
                        continue;
                    }

                    watchers.Add(connectionId);
                    min = min is null ? c.IntervalMs : Math.Min(min.Value, c.IntervalMs);
                }

                if (watchers.Count == 0)
                {
                    _byServer.Remove(serverId);
                }
                else
                {
                    _byServer[serverId] = watchers;
                }

                var sent = _sentInterval.TryGetValue(serverId, out var s) ? s : (int?)null;
                if (min is null && sent is not null)
                {
                    _sentInterval.Remove(serverId);
                    sends.Add((serverId, new Unsubscribe()));
                }
                else if (min is not null && min != sent)
                {
                    _sentInterval[serverId] = min.Value;
                    sends.Add((serverId, new Subscribe(min.Value, TopProcs)));
                }
            }
        }

        foreach (var (serverId, message) in sends)
        {
            if (!registry.TryGet(serverId, out var session) || session.Link is not { } link)
            {
                // Not connected: AgentConnectedAsync repeats the request when the agent comes back.
                lock (_lock)
                {
                    _sentInterval.Remove(serverId);
                }

                continue;
            }

            try
            {
                await link.SendAsync(message, cancellationToken);
                logger.LogDebug("{Type} sent to {ServerId} ({Message})", message.Type, serverId, message);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogDebug("could not send {Type} to {ServerId}: {Error}", message.Type, serverId, ex.Message);
            }
        }
    }
}
