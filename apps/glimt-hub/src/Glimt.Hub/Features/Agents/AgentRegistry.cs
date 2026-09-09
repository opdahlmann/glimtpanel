using System.Collections.Concurrent;

namespace Glimt.Hub.Features.Agents;

/// <summary>serverId → session. Everything real-time lives here, in process memory (IMPLEMENTERINGSPLAN 4.4).</summary>
public sealed class AgentRegistry
{
    private readonly ConcurrentDictionary<string, AgentSession> _sessions = new(StringComparer.Ordinal);

    public IReadOnlyCollection<AgentSession> All => _sessions.Values.ToArray();

    public int Count => _sessions.Count;

    public int ConnectedCount => _sessions.Values.Count(s => s.Connected);

    public AgentSession GetOrAdd(string serverId) => _sessions.GetOrAdd(serverId, static id => new AgentSession(id));

    public bool TryGet(string serverId, out AgentSession session) => _sessions.TryGetValue(serverId, out session!);

    public AgentSession? FindByTokenHash(string tokenHash) =>
        _sessions.Values.FirstOrDefault(s => s.TokenHash.Length > 0 && s.TokenHash == tokenHash);
}
