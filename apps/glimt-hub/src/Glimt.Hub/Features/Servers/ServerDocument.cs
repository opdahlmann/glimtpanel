using MongoDB.Bson.Serialization.Attributes;

namespace Glimt.Hub.Features.Servers;

/// <summary>Collection `servers` (IMPLEMENTERINGSPLAN 4.4). Element names are camelCase by convention.</summary>
public sealed class ServerDocument
{
    public const string Collection = "servers";

    [BsonId]
    public string Id { get; set; } = "";

    /// <summary>Set when a server is enrolled with a one-time key (step 2.4). Dev servers have no owner yet.</summary>
    public string? OwnerId { get; set; }

    public string Hostname { get; set; } = "";
    public string Name { get; set; } = "";
    public List<string> Tags { get; set; } = [];
    public string TokenHash { get; set; } = "";
    public string? PreviousTokenHash { get; set; }
    public DateTime? PreviousTokenValidUntil { get; set; }
    public string Status { get; set; } = "down";
    public DateTime? LastSeenAt { get; set; }
    public string? AgentVersion { get; set; }
    public OsDocument? Os { get; set; }
    public string? Kernel { get; set; }
    public string? Arch { get; set; }
    public int Cores { get; set; }
    public long RamBytes { get; set; }
    public string? DockerMode { get; set; }
    public DateTime CreatedAt { get; set; }
}

public sealed class OsDocument
{
    public string Id { get; set; } = "";
    public string VersionId { get; set; } = "";
    public string PrettyName { get; set; } = "";
}
