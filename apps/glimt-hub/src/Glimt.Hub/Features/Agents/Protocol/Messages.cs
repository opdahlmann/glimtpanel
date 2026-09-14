using System.Text.Json.Serialization;

namespace Glimt.Hub.Features.Agents.Protocol;

/// <summary>Message type names, exactly as in packages/protocol/agent-hub.schema.json (v1).</summary>
public static class MessageTypes
{
    // agent → hub
    public const string Hello = "hello";
    public const string Snapshot = "snapshot";
    public const string Stream = "stream";
    public const string Log = "log";
    public const string LogEnd = "logEnd";
    public const string Pong = "pong";
    public const string Bye = "bye";

    // hub → agent
    public const string Welcome = "welcome";
    public const string AuthFailed = "authFailed";
    public const string Subscribe = "subscribe";
    public const string Unsubscribe = "unsubscribe";
    public const string LogStart = "logStart";
    public const string LogStop = "logStop";
    public const string Rotate = "rotate";
    public const string Ping = "ping";
}

/// <summary>Node kinds in <see cref="Hello"/> (fase 12); missing means server.</summary>
public static class NodeKinds
{
    public const string Server = "server";
    public const string Container = "container";

    public static string Normalize(string? kind) => kind == Container ? Container : Server;
}

/// <summary>Reasons in <see cref="AuthFailed"/>.</summary>
public static class AuthFailures
{
    public const string InvalidKey = "invalidKey";
    public const string ExpiredKey = "expiredKey";
    public const string InvalidToken = "invalidToken";
    public const string ServerRemoved = "serverRemoved";

    /// <summary>A container node sent an enrolment key; it must use the node token from the dashboard (fase 12).</summary>
    public const string ContainerNeedsToken = "containerNeedsToken";
}

/// <summary>Base of every protocol message. `type` is always serialized first.</summary>
public abstract record AgentMessage([property: JsonPropertyOrder(-1)] string Type);

// ---- agent → hub -------------------------------------------------------------------------------

public sealed record Hello(
    int V,
    string? EnrolKey,
    string? Token,
    string Hostname,
    string AgentVersion,
    OsInfo Os,
    string Kernel,
    string Arch,
    int Cores,
    long RamBytes,
    long BootTime,
    string DockerMode,
    string? Kind = null,
    string? ContainerId = null,
    Capabilities? Capabilities = null,
    string? Image = null,
    IReadOnlyList<string>? LogPaths = null) : AgentMessage(MessageTypes.Hello);

/// <summary>What a container agent could read where it runs (fase 12).</summary>
public sealed record Capabilities(bool Cgroup, bool ProcAll, bool Netns, bool Health);

public sealed record OsInfo(string Id, string VersionId, string PrettyName);

public sealed record Snapshot(
    long Ts,
    HostMetrics Host,
    IReadOnlyList<ContainerInfo>? Containers,
    ServicesInfo? Services,
    MaintenanceInfo? Maintenance,
    SecurityInfo? Security,
    HealthInfo? Health = null,
    IReadOnlyList<CheckInfo>? Checks = null) : AgentMessage(MessageTypes.Snapshot);

/// <summary>GET GLIMT_HEALTH_URL (fase 12).</summary>
public sealed record HealthInfo(string Url, bool Ok, int? Status, long? Ms, long CheckedAt, string? Error);

/// <summary>One TCP reachability check from GLIMT_CHECKS (fase 12).</summary>
public sealed record CheckInfo(string Name, string Target, bool Ok, long? Ms, string? Error);

public sealed record Stream(
    long Ts,
    HostMetrics Host,
    IReadOnlyList<ContainerStats>? Containers,
    IReadOnlyList<ProcessInfo>? Processes,
    ProcessTotals? ProcessTotals) : AgentMessage(MessageTypes.Stream);

public sealed record Log(string StreamId, int? Dropped, IReadOnlyList<LogLine> Lines) : AgentMessage(MessageTypes.Log);

public sealed record LogLine(long Ts, string? Unit, string? Container, string? Priority, string Message);

public sealed record LogEnd(string StreamId, string Reason, string? Message) : AgentMessage(MessageTypes.LogEnd);

public sealed record Pong() : AgentMessage(MessageTypes.Pong);

/// <summary>Planned stop (SIGTERM) announced before the socket closes: the node goes to sleeping, not down (fase 12).</summary>
public sealed record Bye(string Reason) : AgentMessage(MessageTypes.Bye);

// ---- hub → agent -------------------------------------------------------------------------------

public sealed record Welcome(string ServerId, string? Token, int SnapshotInterval, int MaintenanceInterval)
    : AgentMessage(MessageTypes.Welcome);

public sealed record AuthFailed(string Reason) : AgentMessage(MessageTypes.AuthFailed);

public sealed record Ping() : AgentMessage(MessageTypes.Ping);

public sealed record Subscribe(int IntervalMs, int? TopProcs) : AgentMessage(MessageTypes.Subscribe);

public sealed record Unsubscribe() : AgentMessage(MessageTypes.Unsubscribe);

public sealed record LogStart(
    string StreamId,
    string Source,
    string? Unit,
    string? Container,
    string? Path,
    string? Priority,
    long? SinceMs,
    int? Tail) : AgentMessage(MessageTypes.LogStart);

public sealed record LogStop(string StreamId) : AgentMessage(MessageTypes.LogStop);

public sealed record Rotate(string Token) : AgentMessage(MessageTypes.Rotate);

// ---- nested payloads ---------------------------------------------------------------------------

public sealed record HostMetrics(
    CpuMetrics Cpu,
    IReadOnlyList<double>? Load,
    MemMetrics Mem,
    long? UptimeSec,
    IReadOnlyList<MountMetrics>? Mounts,
    IReadOnlyList<IfaceMetrics>? Ifaces,
    bool? Approx = null,
    LimitsInfo? Limits = null);

/// <summary>A container's cpu.max cores and memory.max bytes (fase 12); null = no limit.</summary>
public sealed record LimitsInfo(double? CpuCores, long? MemBytes);

public sealed record CpuMetrics(
    double Total,
    double? User,
    [property: JsonPropertyName("system")] double? SystemTime,
    double? Iowait,
    double? Steal,
    IReadOnlyList<double>? PerCore);

public sealed record MemMetrics(long Total, long Used, long Free, long? Buffers, long? Cached, long? SwapTotal, long? SwapUsed);

public sealed record MountMetrics(
    string Path,
    string Fs,
    string? Device,
    long Total,
    long Used,
    long? InodesTotal,
    long? InodesUsed,
    double? ReadBps,
    double? WriteBps);

public sealed record IfaceMetrics(string Name, IReadOnlyList<string>? Ips, double? RxBps, double? TxBps);

public sealed record ContainerInfo(
    string Id,
    string Name,
    string Image,
    long? ImageCreated,
    string State,
    string? Health,
    int? RestartCount,
    long? StartedAt,
    double? CpuPct,
    long? MemBytes,
    long? MemLimit,
    double? RxBps,
    double? TxBps,
    IReadOnlyList<string>? Ports,
    IReadOnlyList<string>? Mounts,
    string? Compose);

public sealed record ContainerStats(string Id, double? CpuPct, long? MemBytes, long? MemLimit, double? RxBps, double? TxBps, string? State);

public sealed record ProcessInfo(int Pid, string Name, string User, double CpuPct, long RssBytes, long? StartedAt, string? Cmdline);

public sealed record ProcessTotals(int? Total, int? Running, int? Blocked);

public sealed record ServicesInfo(IReadOnlyList<ServiceUnit>? Units, IReadOnlyList<string>? Failed, IReadOnlyList<string>? NeedsRestart);

public sealed record ServiceUnit(string Name, string State, bool? NeedsRestart);

public sealed record MaintenanceInfo(
    bool? RebootRequired,
    IReadOnlyList<string>? RebootPkgs,
    int? Updates,
    int? SecurityUpdates,
    long? CheckedAt,
    bool? NeedrestartAvailable);

public sealed record SecurityInfo(
    IReadOnlyList<ListeningPort>? ListeningPorts,
    IReadOnlyList<LoggedInUser>? LoggedIn,
    SshFailed? SshFailed,
    FirewallInfo? Firewall);

public sealed record ListeningPort(int Port, string Proto, string? Process, int? Pid);

public sealed record LoggedInUser(string User, string? From, string? Tty, long? Since);

public sealed record SshFailed(int? Hour, int? Day, IReadOnlyList<SshAttempt>? Last);

public sealed record SshAttempt(string? User, string? From, long? At);

public sealed record FirewallInfo(string? Ufw, string? Fail2ban, int? Banned, int? Blocked);
