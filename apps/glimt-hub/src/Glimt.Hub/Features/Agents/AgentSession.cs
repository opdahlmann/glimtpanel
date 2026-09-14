using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Servers;

namespace Glimt.Hub.Features.Agents;

public static class ServerStatuses
{
    public const string Up = "up";
    public const string Down = "down";

    /// <summary>A container node said bye (planned stop): shown as sleeping, never alerted as down (fase 12).</summary>
    public const string Sleeping = "sleeping";

    /// <summary>Demo servers only.</summary>
    public const string Paused = "paused";
}

/// <summary>
/// In-memory state for one known server. Lives in <see cref="AgentRegistry"/> for the lifetime of the
/// process, whether or not the agent is currently connected.
/// </summary>
public sealed class AgentSession(string serverId, bool isDemo = false)
{
    public static readonly TimeSpan PreviousTokenGrace = TimeSpan.FromMinutes(10);

    /// <summary>How long hello times are kept for restarts24h/restarts10m.</summary>
    public static readonly TimeSpan RestartWindow = TimeSpan.FromHours(24);

    private readonly Lock _lock = new();
    private readonly List<DateTimeOffset> _hellos = [];

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

    /// <summary>`server` or `container` (fase 12). Set by POST /api/servers for container nodes and by every hello.</summary>
    public string Kind { get; private set; } = NodeKinds.Server;

    public bool IsContainer => Kind == NodeKinds.Container;

    public string? ContainerId { get; private set; }
    public Capabilities? Capabilities { get; private set; }
    public string? Image { get; private set; }

    /// <summary>Container nodes: the files `logStart source: file` may tail (GLIMT_LOG_PATHS).</summary>
    public IReadOnlyList<string> LogPaths { get; private set; } = [];
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
            if (hello.Kind is not null)
            {
                Kind = NodeKinds.Normalize(hello.Kind);
            }

            if (IsContainer)
            {
                ContainerId = hello.ContainerId ?? ContainerId;
                Capabilities = hello.Capabilities ?? Capabilities;
                Image = string.IsNullOrEmpty(hello.Image) ? Image : hello.Image;
                LogPaths = hello.LogPaths?.ToArray() ?? [];
                _hellos.Add(now);
                _hellos.RemoveAll(t => now - t > RestartWindow);
            }

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

    /// <summary>Hellos within the window (a container node's restarts: every start is a hello).</summary>
    public int Restarts(TimeSpan window, DateTimeOffset now)
    {
        lock (_lock)
        {
            return _hellos.Count(t => now - t <= window);
        }
    }

    /// <summary>The agent said bye: a planned stop. Stays sleeping until the next hello; never goes down.</summary>
    public void MarkSleeping(DateTimeOffset now)
    {
        lock (_lock)
        {
            LastSeenAt = now;
            Status = ServerStatuses.Sleeping;
        }
    }

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

    /// <summary>Installs a new token hash; the previous one stays accepted for the grace period (10 min for servers, 24 h for container nodes).</summary>
    public void RotateToken(string newTokenHash, DateTimeOffset now, TimeSpan? grace = null)
    {
        lock (_lock)
        {
            if (TokenHash.Length > 0 && TokenHash != newTokenHash)
            {
                PreviousTokenHash = TokenHash;
                PreviousTokenValidUntil = now + (grace ?? PreviousTokenGrace);
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
            Kind = NodeKinds.Normalize(doc.Kind);
            ContainerId = doc.ContainerId;
            Capabilities = doc.Capabilities is { } c ? new Capabilities(c.Cgroup, c.ProcAll, c.Netns, c.Health) : null;
            Image = doc.Image;
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
                Kind = Kind,
                ContainerId = ContainerId,
                Capabilities = Capabilities is { } c ? new CapabilitiesDocument { Cgroup = c.Cgroup, ProcAll = c.ProcAll, Netns = c.Netns, Health = c.Health } : null,
                Image = Image,
                CreatedAt = CreatedAt.UtcDateTime,
            };
        }
    }

    private static DateTimeOffset Utc(DateTime value) => new(DateTime.SpecifyKind(value, DateTimeKind.Utc));
}
