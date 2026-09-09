using System.Collections.Concurrent;

namespace Glimt.Hub.Features.Agents;

/// <summary>serverId → session. Everything real-time lives here, in process memory (IMPLEMENTERINGSPLAN 4.4).</summary>
public sealed class AgentRegistry
{
    private readonly ConcurrentDictionary<string, AgentSession> _sessions = new(StringComparer.Ordinal);

    public IReadOnlyCollection<AgentSession> All => _sessions.Values.ToArray();

    public int Count => _sessions.Count;

    /// <summary>Real agents with an open socket (demo servers are not counted).</summary>
    public int ConnectedCount => _sessions.Values.Count(s => s.Connected && !s.IsDemo);

    public AgentSession GetOrAdd(string serverId) => _sessions.GetOrAdd(serverId, static id => new AgentSession(id));

    /// <summary>Adds a session and reports whether it was new.</summary>
    public AgentSession GetOrAdd(string serverId, out bool added)
    {
        if (_sessions.TryGetValue(serverId, out var existing))
        {
            added = false;
            return existing;
        }

        var created = new AgentSession(serverId);
        added = _sessions.TryAdd(serverId, created);
        return added ? created : _sessions[serverId];
    }

    public AgentSession GetOrAddDemo(string serverId) => _sessions.GetOrAdd(serverId, static id => new AgentSession(id, isDemo: true));

    public bool TryGet(string serverId, out AgentSession session) => _sessions.TryGetValue(serverId, out session!);

    public bool Remove(string serverId) => _sessions.TryRemove(serverId, out _);

    /// <summary>Matches the current token hash, or the previous one while its grace period lasts.</summary>
    public AgentSession? FindByTokenHash(string tokenHash, DateTimeOffset now) =>
        _sessions.Values.FirstOrDefault(s => s.AcceptsTokenHash(tokenHash, now));
}
