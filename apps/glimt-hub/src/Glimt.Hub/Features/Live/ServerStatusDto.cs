using Glimt.Hub.Features.Agents;

namespace Glimt.Hub.Features.Live;

/// <summary>ServerStatus payload for the overview (IMPLEMENTERINGSPLAN 4.3). Serialized camelCase.</summary>
public sealed record ServerStatusDto(
    string Id,
    string Name,
    string Hostname,
    string Status,
    string? LastSeenAt,
    bool Connected,
    string? AgentVersion,
    string? Os,
    string? Arch,
    int? Cores,
    long? RamBytes)
{
    public static ServerStatusDto From(AgentSession session) => new(
        session.ServerId,
        session.Name,
        session.Hostname,
        session.Status,
        session.LastSeenAt?.UtcDateTime.ToString("o"),
        session.Connected,
        session.AgentVersion,
        session.Os?.PrettyName,
        session.Arch,
        session.Cores > 0 ? session.Cores : null,
        session.RamBytes > 0 ? session.RamBytes : null);
}
