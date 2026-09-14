using System.Security.Cryptography;
using System.Text;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Buffer;

namespace Glimt.Hub.Features.Demo;

/// <summary>One TCP check a demo node reports (GLIMT_CHECKS).</summary>
public sealed record DemoCheck(string Name, string Target, bool Ok = true);

/// <summary>
/// A demo container node (IMPLEMENTERINGSPLAN step 12.11). <paramref name="LinkedHost"/>/<paramref name="LinkedContainer"/>
/// name a demo server and one of its containers so the node links to it through the host's snapshot; <paramref name="SleepFrom"/>
/// and <paramref name="SleepTo"/> ("02:00", "06:00") make the node say bye and sleep in that window of the hub's local time.
/// </summary>
public sealed record DemoNodeDefinition(
    string Name,
    string[] Tags,
    string Image,
    double Cores,
    int MemLimitMb,
    bool Cgroup,
    string? HealthUrl,
    DemoCheck[] Checks,
    string? LinkedHost,
    string? LinkedContainer,
    string? SleepFrom,
    string? SleepTo,
    double CpuBase,
    double MemBase,
    string[] LogPaths,
    int[] Ports);

/// <summary>
/// One simulated container node: what a glimt-agent inside a container would send (hello with kind container, a
/// snapshot without services/maintenance/containers, health and checks, a stream with a few processes). Drifts like
/// <see cref="FakeServer"/>.
/// </summary>
public sealed class FakeNode
{
    private const double MB = 1024 * 1024;
    private const long GB = 1024L * 1024 * 1024;
    private const long HostRam = 16 * GB;

    private readonly Random _rng;
    private double _drift;

    public FakeNode(DemoNodeDefinition definition, Random rng, DateTimeOffset now, string? serverId = null)
    {
        _rng = rng;
        Definition = definition;
        ServerId = serverId ?? DemoData.ServerIdPrefix + definition.Name;
        Cpu = definition.CpuBase;
        Mem = definition.MemBase;
        UptimeSeconds = 3 * 86_400 + 4 * 3600 + 17 * 60;
        BootTime = now.AddSeconds(-UptimeSeconds).ToUnixTimeMilliseconds();
        ContainerId = definition.LinkedHost is { } host && definition.LinkedContainer is { } container
            ? FakeServer.ContainerId($"{host}/{container}")
            : Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes("node/" + definition.Name)))[..12];
        Checks = definition.Checks.Select(c => c with { }).ToList();
    }

    public DemoNodeDefinition Definition { get; }
    public string ServerId { get; }
    public string Name => Definition.Name;
    public string ContainerId { get; }

    /// <summary>False while the node sleeps (bye) or after POST /api/e2e/sleep-node.</summary>
    public bool Online { get; set; } = true;

    /// <summary>The health check's outcome; POST /api/e2e/fail-health flips it.</summary>
    public bool HealthOk { get; set; } = true;

    public List<DemoCheck> Checks { get; }
    public double Cpu { get; private set; }
    public double Mem { get; private set; }
    public long UptimeSeconds { get; private set; }
    public long BootTime { get; private set; }

    public long MemLimitBytes => Definition.MemLimitMb > 0 ? (long)(Definition.MemLimitMb * MB) : 0;
    public long RamBytes => MemLimitBytes > 0 ? MemLimitBytes : HostRam;

    public Hello Hello() => new(
        1,
        null,
        null,
        Name,
        "0.1.0",
        new OsInfo("debian", "12", "Debian GNU/Linux 12 (bookworm)"),
        "6.8.0-45-generic",
        "amd64",
        (int)Math.Ceiling(Definition.Cores > 0 ? Definition.Cores : 4),
        RamBytes,
        BootTime,
        "none",
        NodeKinds.Container,
        ContainerId,
        new Capabilities(Definition.Cgroup, true, true, Definition.HealthUrl is not null),
        Definition.Image,
        Definition.LogPaths.Length == 0 ? null : Definition.LogPaths);

    /// <summary>One second of drift.</summary>
    public void Tick()
    {
        _drift += (_rng.NextDouble() - 0.5) * 4;
        _drift = Math.Clamp(_drift, -12, 12);
        Cpu = Math.Clamp(Definition.CpuBase + _drift + (_rng.NextDouble() - 0.5) * 3, 0.5, 99);
        Mem = Math.Clamp(Definition.MemBase + _drift / 4, 5, 99);
        UptimeSeconds++;
    }

    /// <summary>A restart at the given time: uptime starts over (the next hello counts as a restart).</summary>
    public void Restart(DateTimeOffset now)
    {
        UptimeSeconds = 0;
        BootTime = now.ToUnixTimeMilliseconds();
    }

    public Snapshot Snapshot(long ts) => new(
        ts,
        Host(),
        null,
        null,
        null,
        new SecurityInfo(Definition.Ports.Select(p => new ListeningPort(p, "tcp", Definition.Image.Split(':')[0].Split('/')[^1], 1)).ToList(), null, null, null),
        Definition.HealthUrl is { } url
            ? new HealthInfo(url, HealthOk, HealthOk ? 200 : 503, HealthOk ? _rng.Next(4, 60) : 1240, ts, HealthOk ? null : "503 Service Unavailable")
            : null,
        Checks.Count == 0 ? null : Checks.Select(c => new CheckInfo(c.Name, c.Target, c.Ok, c.Ok ? _rng.Next(1, 9) : 2000, c.Ok ? null : "timeout")).ToList());

    public Agents.Protocol.Stream Stream(long ts) => new(
        ts,
        Host(),
        null,
        Processes(),
        new ProcessTotals(6, 1, 0));

    /// <summary>Buffer point i of n for the last 24 h: a gentle sine around the base.</summary>
    public PointInput HistoryPoint(int i, int n, long ts)
    {
        var phase = i / (double)n * Math.PI * 2;
        var cpu = Math.Clamp(Definition.CpuBase + Math.Sin(phase) * 8 + (_rng.NextDouble() - 0.5) * 4, 1, 99);
        var mem = Math.Clamp(Definition.MemBase + Math.Sin(phase / 2) * 3, 5, 99);
        return new PointInput(ts, (float)cpu, (float)mem, 0, [new DiskInput("/", 38f)], [new IfaceInput("eth0", 120_000f, 40_000f)], []);
    }

    private HostMetrics Host()
    {
        var total = RamBytes;
        var used = (long)(total * Mem / 100);
        return new HostMetrics(
            new CpuMetrics(Round(Cpu), Round(Cpu * 0.8), Round(Cpu * 0.2), 0, 0, null),
            null,
            new MemMetrics(total, used, total - used, 0, (long)(used * 0.15), 0, 0),
            UptimeSeconds,
            [
                new MountMetrics("/", "overlay", null, 10 * GB, (long)(3.8 * GB), 655_360, 212_400, Round(_rng.Next(0, 300_000)), Round(_rng.Next(0, 900_000))),
                new MountMetrics("/data", "ext4", "/dev/sdb1", 50 * GB, (long)(31.2 * GB), 3_276_800, 118_000, Round(_rng.Next(0, 2_000_000)), Round(_rng.Next(0, 4_000_000))),
            ],
            [new IfaceMetrics("eth0", ["172.18.0.4"], Round(_rng.Next(20_000, 900_000)), Round(_rng.Next(5_000, 300_000)))],
            Definition.Cgroup ? null : true,
            new LimitsInfo(Definition.Cores > 0 ? Definition.Cores : null, MemLimitBytes > 0 ? MemLimitBytes : null));
    }

    private List<ProcessInfo> Processes()
    {
        var app = Definition.Image.Split(':')[0].Split('/')[^1];
        var rss = (long)(RamBytes * Mem / 100);
        return
        [
            new ProcessInfo(1, app, "app", Round(Cpu * 0.7), (long)(rss * 0.6), BootTime, $"{app} --port {Definition.Ports.FirstOrDefault(8080)}"),
            new ProcessInfo(17, app, "app", Round(Cpu * 0.2), (long)(rss * 0.25), BootTime + 2000, $"{app}: worker"),
            new ProcessInfo(18, app, "app", Round(Cpu * 0.1), (long)(rss * 0.15), BootTime + 2000, $"{app}: worker"),
        ];
    }

    private static double Round(double value) => Math.Round(value, 1);
}
