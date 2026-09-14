using Glimt.Hub.Features.Alerts;
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

    /// <summary>`server` (also when missing, for documents from before fase 12) or `container`.</summary>
    public string? Kind { get; set; }

    /// <summary>Container nodes: the first 12 characters of the container id from hello, used to link the node to the host agent's container.</summary>
    public string? ContainerId { get; set; }

    public CapabilitiesDocument? Capabilities { get; set; }

    /// <summary>Container nodes: GLIMT_IMAGE from hello.</summary>
    public string? Image { get; set; }

    /// <summary>Per-server rule overrides (step 7.4): rule id → enabled/threshold/durationSec. Empty or null = account defaults.</summary>
    public Dictionary<string, RuleSettingDocument>? AlertOverrides { get; set; }

    /// <summary>Notifications are suppressed until this time (POST /api/alerts/silence); the state machine keeps running.</summary>
    public DateTime? SilencedUntil { get; set; }

    /// <summary>«Mute all alerts for this server»: like a silence without an end.</summary>
    public bool AlertsMuted { get; set; }

    public DateTime CreatedAt { get; set; }
}

/// <summary>What the container profile could read (hello.capabilities, fase 12).</summary>
public sealed class CapabilitiesDocument
{
    public bool Cgroup { get; set; }
    public bool ProcAll { get; set; }
    public bool Netns { get; set; }
    public bool Health { get; set; }
}

public sealed class OsDocument
{
    public string Id { get; set; } = "";
    public string VersionId { get; set; } = "";
    public string PrettyName { get; set; } = "";
}
