using System.Collections.Concurrent;

namespace Glimt.Hub.Features.Alerts;

/// <summary>Active alerts per server on the card: count and worst severity.</summary>
public sealed record AlertSummary(int Count, string? WorstSeverity)
{
    public static readonly AlertSummary None = new(0, null);
}

/// <summary>
/// The engine's view of what is firing per server, kept separately so the Live projections can read it without
/// depending on the engine (the engine depends on Live through its sinks).
/// </summary>
public sealed class ActiveAlertCounts
{
    private readonly ConcurrentDictionary<string, AlertSummary> _byServer = new(StringComparer.Ordinal);

    public AlertSummary Get(string serverId) => _byServer.TryGetValue(serverId, out var summary) ? summary : AlertSummary.None;

    public void Set(string serverId, AlertSummary summary)
    {
        if (summary.Count == 0)
        {
            _byServer.TryRemove(serverId, out _);
        }
        else
        {
            _byServer[serverId] = summary;
        }
    }

    public void Remove(string serverId) => _byServer.TryRemove(serverId, out _);
}
