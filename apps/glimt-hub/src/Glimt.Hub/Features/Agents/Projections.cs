using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Buffer;

namespace Glimt.Hub.Features.Agents;

/// <summary>Worst mount on the card.</summary>
public sealed record DiskWorstDto(string Path, double Pct);

/// <summary>
/// The overview card (IMPLEMENTERINGSPLAN 4.3): everything the server card shows, under 600 bytes in
/// MessagePack (the two sparklines are whole percents, one byte each).
/// </summary>
public sealed record CardDto(
    string Id,
    string Name,
    string Hostname,
    IReadOnlyList<string> Tags,
    string Status,
    bool Connected,
    string? LastSeenAt,
    string? Os,
    string? VersionId,
    string? Arch,
    int? Cores,
    long? RamBytes,
    long? UptimeSec,
    double? Cpu,
    double? Mem,
    DiskWorstDto? DiskWorst,
    double? NetRx,
    double? NetTx,
    int ContainersRunning,
    int ContainersTotal,
    int ContainersBad,
    int? Updates,
    int? SecurityUpdates,
    bool? RebootRequired,
    int FailedServices,
    int ActiveAlerts,
    string? AlertSeverity,
    int?[] CpuLastHour,
    int?[] MemLastHour);

/// <summary>The full server page model: the last snapshot merged with the last stream.</summary>
public sealed record ServerDto(
    string Id,
    string Name,
    string Hostname,
    IReadOnlyList<string> Tags,
    string Status,
    bool Connected,
    string? LastSeenAt,
    string? AgentVersion,
    OsInfo? Os,
    string? Kernel,
    string? Arch,
    int? Cores,
    long? RamBytes,
    string? DockerMode,
    long? BootTime,
    long? UptimeSec,
    HostMetrics? Host,
    IReadOnlyList<ProcessInfo>? Processes,
    ProcessTotals? ProcessTotals,
    IReadOnlyList<ContainerInfo>? Containers,
    ServicesInfo? Services,
    MaintenanceInfo? Maintenance,
    SecurityInfo? Security,
    string? SnapshotAt,
    string? StreamAt);

/// <summary>Builds the Card and Server projections from a session (and the buffer for the sparklines).</summary>
public static class Projections
{
    public static CardDto Card(AgentSession session, ServerBuffer? buffer, DateTimeOffset now, AlertSummary? alerts = null)
    {
        alerts ??= AlertSummary.None;
        var snapshot = session.LastSnapshot;
        var host = MergedHost(session);
        var containers = MergedContainers(session);
        var up = session.Status == ServerStatuses.Up;

        double? cpu = null, mem = null, rx = null, tx = null;
        DiskWorstDto? worst = null;
        if (host is not null && up)
        {
            cpu = Round(host.Cpu.Total);
            mem = host.Mem.Total > 0 ? Round(host.Mem.Used * 100.0 / host.Mem.Total) : null;
            foreach (var mount in host.Mounts ?? [])
            {
                var pct = mount.Total > 0 ? mount.Used * 100.0 / mount.Total : 0;
                if (worst is null || pct > worst.Pct)
                {
                    worst = new DiskWorstDto(mount.Path, Round(pct));
                }
            }

            if (host.Ifaces is { Count: > 0 } ifaces)
            {
                rx = Round(ifaces.Sum(i => i.RxBps ?? 0));
                tx = Round(ifaces.Sum(i => i.TxBps ?? 0));
            }
        }

        var total = containers?.Count ?? 0;
        var running = containers?.Count(c => c.State == "running") ?? 0;
        var maintenance = snapshot?.Maintenance;
        return new CardDto(
            session.ServerId,
            session.Name,
            session.Hostname,
            session.Tags,
            session.Status,
            session.Connected,
            Iso(session.LastSeenAt),
            session.Os?.PrettyName,
            session.Os?.VersionId,
            session.Arch,
            session.Cores > 0 ? session.Cores : null,
            session.RamBytes > 0 ? session.RamBytes : null,
            up ? host?.UptimeSec : null,
            cpu,
            mem,
            worst,
            rx,
            tx,
            running,
            total,
            total - running,
            maintenance?.Updates,
            maintenance?.SecurityUpdates,
            maintenance?.RebootRequired,
            snapshot?.Services?.Failed?.Count ?? 0,
            alerts.Count,
            alerts.WorstSeverity,
            HistoryQuery.LastHourPercent(buffer, "cpu", now),
            HistoryQuery.LastHourPercent(buffer, "mem", now));
    }

    public static ServerDto Server(AgentSession session)
    {
        var snapshot = session.LastSnapshot;
        var stream = session.LastStream;
        var host = MergedHost(session);
        return new ServerDto(
            session.ServerId,
            session.Name,
            session.Hostname,
            session.Tags,
            session.Status,
            session.Connected,
            Iso(session.LastSeenAt),
            session.AgentVersion,
            session.Os,
            session.Kernel,
            session.Arch,
            session.Cores > 0 ? session.Cores : null,
            session.RamBytes > 0 ? session.RamBytes : null,
            session.DockerMode,
            session.BootTime > 0 ? session.BootTime : null,
            host?.UptimeSec,
            host,
            stream?.Processes,
            stream?.ProcessTotals,
            MergedContainers(session),
            snapshot?.Services,
            snapshot?.Maintenance,
            snapshot?.Security,
            Iso(session.SnapshotAt),
            Iso(session.StreamAt));
    }

    /// <summary>The newest host block; mounts/ifaces fall back to the other frame when the newest lacks them.</summary>
    private static HostMetrics? MergedHost(AgentSession session)
    {
        var snapshot = session.LastSnapshot?.Host;
        var stream = session.LastStream?.Host;
        if (snapshot is null || stream is null)
        {
            return stream ?? snapshot;
        }

        var (newest, other) = StreamIsNewer(session) ? (stream, snapshot) : (snapshot, stream);
        return newest with
        {
            Load = newest.Load ?? other.Load,
            UptimeSec = newest.UptimeSec ?? other.UptimeSec,
            Mounts = newest.Mounts ?? other.Mounts,
            Ifaces = newest.Ifaces ?? other.Ifaces,
        };
    }

    /// <summary>Snapshot containers with the stream's cpu/mem/net/state laid over them when the stream is newer.</summary>
    private static IReadOnlyList<ContainerInfo>? MergedContainers(AgentSession session)
    {
        var containers = session.LastSnapshot?.Containers;
        var stats = session.LastStream?.Containers;
        if (containers is null || stats is null || stats.Count == 0 || !StreamIsNewer(session))
        {
            return containers;
        }

        var byId = stats.ToDictionary(s => s.Id, StringComparer.Ordinal);
        var merged = new List<ContainerInfo>(containers.Count);
        foreach (var c in containers)
        {
            merged.Add(byId.TryGetValue(c.Id, out var s)
                ? c with
                {
                    CpuPct = s.CpuPct ?? c.CpuPct,
                    MemBytes = s.MemBytes ?? c.MemBytes,
                    MemLimit = s.MemLimit ?? c.MemLimit,
                    RxBps = s.RxBps ?? c.RxBps,
                    TxBps = s.TxBps ?? c.TxBps,
                    State = s.State ?? c.State,
                }
                : c);
        }

        return merged;
    }

    private static bool StreamIsNewer(AgentSession session) =>
        session.StreamAt is { } s && (session.SnapshotAt is not { } n || s >= n);

    private static string? Iso(DateTimeOffset? at) => at?.UtcDateTime.ToString("o");

    private static double Round(double value) => Math.Round(value, 1);
}
