namespace Glimt.Hub.Features.Live;

/// <summary>
/// Who is connected to the live hub and what each connection can see on the overview. The visible set is
/// what SubscribeOverview computed through IAccessService, extended when a new server shows up.
/// </summary>
public sealed class LiveConnections
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, Entry> _connections = new(StringComparer.Ordinal);

    private sealed class Entry(string userId)
    {
        public string UserId { get; } = userId;
        public bool Overview { get; set; }
        public HashSet<string> Visible { get; } = new(StringComparer.Ordinal);
    }

    public int Count
    {
        get
        {
            lock (_lock)
            {
                return _connections.Count;
            }
        }
    }

    public void Connected(string connectionId, string userId)
    {
        lock (_lock)
        {
            _connections[connectionId] = new Entry(userId);
        }
    }

    public void Disconnected(string connectionId)
    {
        lock (_lock)
        {
            _connections.Remove(connectionId);
        }
    }

    public void SetOverview(string connectionId, IEnumerable<string> visibleServerIds)
    {
        lock (_lock)
        {
            if (_connections.TryGetValue(connectionId, out var entry))
            {
                entry.Overview = true;
                entry.Visible.Clear();
                entry.Visible.UnionWith(visibleServerIds);
            }
        }
    }

    public void ClearOverview(string connectionId)
    {
        lock (_lock)
        {
            if (_connections.TryGetValue(connectionId, out var entry))
            {
                entry.Overview = false;
                entry.Visible.Clear();
            }
        }
    }

    public void AddVisible(string connectionId, string serverId)
    {
        lock (_lock)
        {
            if (_connections.TryGetValue(connectionId, out var entry) && entry.Overview)
            {
                entry.Visible.Add(serverId);
            }
        }
    }

    public void ForgetServer(string serverId)
    {
        lock (_lock)
        {
            foreach (var entry in _connections.Values)
            {
                entry.Visible.Remove(serverId);
            }
        }
    }

    /// <summary>Overview connections whose visible set does not contain the server yet (candidates for a re-check).</summary>
    public IReadOnlyList<(string ConnectionId, string UserId)> OverviewConnectionsMissing(string serverId)
    {
        lock (_lock)
        {
            return _connections.Where(kv => kv.Value.Overview && !kv.Value.Visible.Contains(serverId))
                .Select(kv => (kv.Key, kv.Value.UserId))
                .ToArray();
        }
    }

    /// <summary>User ids with an overview subscription that includes the server.</summary>
    public IReadOnlyCollection<string> OverviewUsersSeeing(string serverId)
    {
        lock (_lock)
        {
            return _connections.Values.Where(e => e.Overview && e.Visible.Contains(serverId)).Select(e => e.UserId).Distinct(StringComparer.Ordinal).ToArray();
        }
    }
}
