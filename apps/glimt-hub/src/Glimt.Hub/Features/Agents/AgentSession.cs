using System.Text.Json;
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
public sealed class AgentSession(string serverId)
{
    private readonly Lock _lock = new();

    public string ServerId { get; } = serverId;
    public string Hostname { get; private set; } = "";
    public string Name { get; private set; } = "";
    public bool Connected { get; private set; }
    public string? ConnectionId { get; private set; }
    public DateTimeOffset? LastSeenAt { get; private set; }
    public string? AgentVersion { get; private set; }
    public OsInfo? Os { get; private set; }
    public string? Kernel { get; private set; }
    public string? Arch { get; private set; }
    public int Cores { get; private set; }
    public long RamBytes { get; private set; }
    public string? DockerMode { get; private set; }
    public string TokenHash { get; set; } = "";
    public DateTimeOffset CreatedAt { get; private set; }

    /// <summary>Last snapshot/stream frames, kept raw until the buffer and projections arrive (steps 2.6, 2.7).</summary>
    public JsonElement? LastSnapshot { get; private set; }

    public JsonElement? LastStream { get; private set; }

    /// <summary>up while connected or seen within GLIMT_DOWN_AFTER_SECONDS, otherwise down.</summary>
    public string Status { get; private set; } = ServerStatuses.Down;

    /// <summary>Binds an accepted connection to the session and marks the server up.</summary>
    public void Attach(string connectionId, Hello hello, DateTimeOffset now)
    {
        lock (_lock)
        {
            ConnectionId = connectionId;
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
            DockerMode = hello.DockerMode;
            Connected = true;
            LastSeenAt = now;
            Status = ServerStatuses.Up;
            if (CreatedAt == default)
            {
                CreatedAt = now;
            }
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
            Connected = false;
            return true;
        }
    }

    public void Touch(DateTimeOffset now) => LastSeenAt = now;

    public void StoreSnapshot(JsonElement raw, DateTimeOffset now)
    {
        LastSnapshot = raw;
        LastSeenAt = now;
    }

    public void StoreStream(JsonElement raw, DateTimeOffset now)
    {
        LastStream = raw;
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

    /// <summary>Fills a session from the persisted server document (token resume after a hub restart).</summary>
    public void Restore(ServerDocument doc)
    {
        lock (_lock)
        {
            Hostname = doc.Hostname;
            Name = doc.Name;
            TokenHash = doc.TokenHash;
            Status = doc.Status;
            LastSeenAt = doc.LastSeenAt is { } seen ? new DateTimeOffset(DateTime.SpecifyKind(seen, DateTimeKind.Utc)) : null;
            AgentVersion = doc.AgentVersion;
            Os = doc.Os is { } os ? new OsInfo(os.Id, os.VersionId, os.PrettyName) : null;
            Kernel = doc.Kernel;
            Arch = doc.Arch;
            Cores = doc.Cores;
            RamBytes = doc.RamBytes;
            DockerMode = doc.DockerMode;
            CreatedAt = new DateTimeOffset(DateTime.SpecifyKind(doc.CreatedAt, DateTimeKind.Utc));
        }
    }

    public ServerDocument ToDocument()
    {
        lock (_lock)
        {
            return new ServerDocument
            {
                Id = ServerId,
                Hostname = Hostname,
                Name = Name,
                TokenHash = TokenHash,
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
}
