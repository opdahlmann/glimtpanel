using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Servers;

namespace Glimt.Hub.Features.Agents;

public static class ServerStatuses
{
    public const string Up = "up";
    public const string Down = "down";
}

/// <summary>
/// In-memory state for one known server. Lives in <see cref="AgentRegistry"/> for the lifetime of the
/// process, whether or not the agent is currently connected.
/// </summary>
public sealed class AgentSession(string serverId, bool isDemo = false)
{
    public static readonly TimeSpan PreviousTokenGrace = TimeSpan.FromMinutes(10);

    private readonly Lock _lock = new();

    public string ServerId { get; } = serverId;

    /// <summary>Fake server from the Demo feature: no socket, not counted as a connected agent in /healthz.</summary>
    public bool IsDemo { get; } = isDemo;

    public string Hostname { get; private set; } = "";
    public string Name { get; private set; } = "";
    public IReadOnlyList<string> Tags { get; private set; } = [];
    public string? OwnerId { get; set; }
    public bool Connected { get; private set; }
    public string? ConnectionId { get; private set; }

    /// <summary>The way to reach the agent while connected (subscribe, logStart, rotate, close).</summary>
    public IAgentLink? Link { get; private set; }

    public DateTimeOffset? LastSeenAt { get; private set; }
    public string? AgentVersion { get; private set; }
    public OsInfo? Os { get; private set; }
    public string? Kernel { get; private set; }
    public string? Arch { get; private set; }
    public int Cores { get; private set; }
    public long RamBytes { get; private set; }
    public long BootTime { get; private set; }
    public string? DockerMode { get; private set; }
    public string TokenHash { get; set; } = "";

    /// <summary>After a rotate the old token stays valid for <see cref="PreviousTokenGrace"/>.</summary>
    public string? PreviousTokenHash { get; private set; }

    public DateTimeOffset? PreviousTokenValidUntil { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }

    /// <summary>Last parsed snapshot and stream; the Server projection merges them.</summary>
    public Snapshot? LastSnapshot { get; private set; }

    public DateTimeOffset? SnapshotAt { get; private set; }

    public Protocol.Stream? LastStream { get; private set; }

    public DateTimeOffset? StreamAt { get; private set; }

    /// <summary>up while connected or seen within GLIMT_DOWN_AFTER_SECONDS, otherwise down.</summary>
    public string Status { get; private set; } = ServerStatuses.Down;

    /// <summary>Binds an accepted connection to the session and marks the server up. Returns the link it replaced, if any.</summary>
    public IAgentLink? Attach(IAgentLink link, Hello hello, DateTimeOffset now)
    {
        lock (_lock)
        {
            var replaced = Link is { } old && old.ConnectionId != link.ConnectionId ? old : null;
            ConnectionId = link.ConnectionId;
            Link = link;
            Hostname = hello.Hostname;
            if (Name.Length == 0)
            {
                Name = hello.Hostname;
            }

            AgentVersion = hello.AgentVersion;
            Os = hello.Os;
            Kernel = hello.Kernel;
            Arch = hello.Arch;
            Cores = hello.Cores;
            RamBytes = hello.RamBytes;
            BootTime = hello.BootTime;
            DockerMode = hello.DockerMode;
            Connected = true;
            LastSeenAt = now;
            Status = ServerStatuses.Up;
            if (CreatedAt == default)
            {
                CreatedAt = now;
            }

            return replaced;
        }
    }

    /// <summary>Marks the session disconnected if <paramref name="connectionId"/> is still the active one.</summary>
    public bool Detach(string connectionId)
    {
        lock (_lock)
        {
            if (ConnectionId != connectionId)
            {
                return false;
            }

            ConnectionId = null;
            Link = null;
            Connected = false;
            return true;
        }
    }

    public void Touch(DateTimeOffset now) => LastSeenAt = now;

    public void StoreSnapshot(Snapshot snapshot, DateTimeOffset now)
    {
        LastSnapshot = snapshot;
        SnapshotAt = now;
        LastSeenAt = now;
    }

    public void StoreStream(Protocol.Stream stream, DateTimeOffset now)
    {
        LastStream = stream;
        StreamAt = now;
        LastSeenAt = now;
    }

    /// <summary>Sets the status and reports whether it changed.</summary>
    public bool TrySetStatus(string status)
    {
        lock (_lock)
        {
            if (Status == status)
            {
                return false;
            }

            Status = status;
            return true;
        }
    }

    /// <summary>Marks a server down as of <paramref name="lastSeenAt"/> (demo servers, or a detach without socket).</summary>
    public void MarkDown(DateTimeOffset lastSeenAt)
    {
        lock (_lock)
        {
            LastSeenAt = lastSeenAt;
            Status = ServerStatuses.Down;
        }
    }

    /// <summary>Name and tags from the servers collection (or the demo definitions).</summary>
    public void SetIdentity(string name, IReadOnlyList<string> tags)
    {
        lock (_lock)
        {
            Name = name;
            Tags = tags;
        }
    }

    /// <summary>Installs a new token hash; the previous one stays accepted for the grace period.</summary>
    public void RotateToken(string newTokenHash, DateTimeOffset now)
    {
        lock (_lock)
        {
            if (TokenHash.Length > 0 && TokenHash != newTokenHash)
            {
                PreviousTokenHash = TokenHash;
                PreviousTokenValidUntil = now + PreviousTokenGrace;
            }

            TokenHash = newTokenHash;
        }
    }

    public bool AcceptsTokenHash(string hash, DateTimeOffset now)
    {
        lock (_lock)
        {
            if (TokenHash.Length > 0 && TokenHash == hash)
            {
                return true;
            }

            return PreviousTokenHash is { Length: > 0 } previous && previous == hash && PreviousTokenValidUntil > now;
        }
    }

    /// <summary>Fills a session from the persisted server document (token resume after a hub restart).</summary>
    public void Restore(ServerDocument doc)
    {
        lock (_lock)
        {
            Hostname = doc.Hostname;
            Name = doc.Name;
            Tags = doc.Tags.ToArray();
            OwnerId = doc.OwnerId;
            TokenHash = doc.TokenHash;
            PreviousTokenHash = doc.PreviousTokenHash;
            PreviousTokenValidUntil = doc.PreviousTokenValidUntil is { } until ? Utc(until) : null;
            Status = doc.Status;
            LastSeenAt = doc.LastSeenAt is { } seen ? Utc(seen) : null;
            AgentVersion = doc.AgentVersion;
            Os = doc.Os is { } os ? new OsInfo(os.Id, os.VersionId, os.PrettyName) : null;
            Kernel = doc.Kernel;
            Arch = doc.Arch;
            Cores = doc.Cores;
            RamBytes = doc.RamBytes;
            DockerMode = doc.DockerMode;
            CreatedAt = Utc(doc.CreatedAt);
        }
    }

    public ServerDocument ToDocument()
    {
        lock (_lock)
        {
            return new ServerDocument
            {
                Id = ServerId,
                OwnerId = OwnerId,
                Hostname = Hostname,
                Name = Name,
                Tags = Tags.ToList(),
                TokenHash = TokenHash,
                PreviousTokenHash = PreviousTokenHash,
                PreviousTokenValidUntil = PreviousTokenValidUntil?.UtcDateTime,
                Status = Status,
                LastSeenAt = LastSeenAt?.UtcDateTime,
                AgentVersion = AgentVersion,
                Os = Os is { } os ? new OsDocument { Id = os.Id, VersionId = os.VersionId, PrettyName = os.PrettyName } : null,
                Kernel = Kernel,
                Arch = Arch,
                Cores = Cores,
                RamBytes = RamBytes,
                DockerMode = DockerMode,
                CreatedAt = CreatedAt.UtcDateTime,
            };
        }
    }

    private static DateTimeOffset Utc(DateTime value) => new(DateTime.SpecifyKind(value, DateTimeKind.Utc));
}
