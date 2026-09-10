using System.Security.Cryptography;
using System.Text;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Buffer;

namespace Glimt.Hub.Features.Demo;

/// <summary>
/// One simulated server: state that drifts every second exactly like simulate() in glimtData.js, and
/// builders for the protocol's hello, snapshot and stream messages plus 24 h of buffer history.
/// </summary>
public sealed class FakeServer
{
    // Binary units, so an "8 GB" demo server reads as 8 GB in the web app (which formats with 1024).
    private const double MB = 1024 * 1024;
    private const long GB = 1024L * 1024 * 1024;

    private readonly Random _rng;
    private readonly string _prefix;

    public FakeServer(int index, DemoDefinition definition, Random rng, DateTimeOffset now)
    {
        _rng = rng;
        Index = index;
        Definition = definition;
        ServerId = DemoData.ServerIdPrefix + definition.Name;
        _prefix = definition.Name.Split('-')[0];
        Online = definition.Flags.DownAt is null;
        Cpu = definition.CpuBase;
        Mem = definition.MemBase;
        PerCore = Enumerable.Repeat(definition.CpuBase, definition.Cores).ToArray();
        Load = [0, 0, 0];
        SwapPct = definition.Name switch { "db-prod" => 0.4, "cache-01" => 1.2, _ => 0 };
        UptimeSeconds = DemoData.UptimeSeconds[index];
        BootTime = now.AddSeconds(-UptimeSeconds).ToUnixTimeMilliseconds();
        FailedUnits = definition.Flags.Failed is { } failed ? [failed] : [];

        Mounts = definition.Mounts.Select(m => new FakeMount(m.Path, m.Fs, m.TotalGb * GB, m.Pct, m.Path == "/var" ? 91 : Rnd(3, 30), Rnd(0, 20), Rnd(0, 40))).ToList();
        Ifaces = [new FakeIface("eth0", $"10.0.{index}.12", Rnd(0.5, 20), Rnd(0.1, 5))];
        if (index % 3 == 0)
        {
            Ifaces.Add(new FakeIface("docker0", "172.17.0.1", Rnd(0, 3), Rnd(0, 3)));
        }

        Containers = [];
        for (var i = 0; i < definition.Containers; i++)
        {
            var kind = DemoData.ContainerKinds[i % DemoData.ContainerKinds.Length];
            var name = $"{_prefix}-{kind}";
            var loop = definition.Flags.RestartLoop == name;
            var stopped = definition.Name == "web-01" && kind == "cron";
            var limitMb = i % 3 == 0 ? 1024 : i % 3 == 1 ? 512 : 0;
            Containers.Add(new FakeContainer
            {
                Id = ContainerId($"{definition.Name}/{name}"),
                Name = name,
                Kind = kind,
                Image = DemoData.Images[kind],
                State = stopped ? "exited" : loop ? "restarting" : "running",
                CpuPct = Rnd(0.5, 12),
                MemMb = limitMb > 0 ? Rnd(limitMb * 0.3, limitMb * 0.85) : Rnd(40, 900),
                LimitMb = limitMb,
                RestartCount = loop ? 7 : i % 4 == 0 ? 1 : 0,
                ImageAgeDays = DemoData.ContainerImageAgeDays[i % 6],
                Health = i % 2 == 0 ? "healthy" : "none",
                UpSeconds = loop ? 41 : DemoData.ParseAge(DemoData.ContainerAges[i % 6]),
                NetIn = Rnd(0, 3),
                NetOut = Rnd(0, 1),
                Ports = kind switch
                {
                    "web" => ["80→8080", "443→8443"],
                    "db" => ["5432→5432"],
                    "redis" or "cache" => ["6379→6379"],
                    "api" => ["3000→3000"],
                    "proxy" => ["80→80", "443→443", "8080→8080"],
                    _ => [],
                },
                Mounts = kind switch
                {
                    "db" => ["pgdata → /var/lib/postgresql/data"],
                    "web" => ["./nginx → /etc/nginx/conf.d"],
                    "search" => ["meili → /meili_data"],
                    _ => [],
                },
            });
        }

        Processes = [];
        for (var i = 0; i < DemoData.Processes.Length; i++)
        {
            var (name, user) = DemoData.Processes[i];
            Processes.Add(new FakeProcess
            {
                Pid = 1000 + i * 37 + index * 3,
                Name = name,
                User = user,
                CpuBase = i == 0 ? (definition.CpuBase > 90 ? 60 : Rnd(15, 30)) : Rnd(0.1, 6),
                MemMb = DemoData.ProcessMemMb[i],
                Cmdline = DemoData.Commands[name],
                StartedAt = BootTime + (i + 1) * 90_000,
            });
        }
    }

    public int Index { get; }
    public DemoDefinition Definition { get; }
    public string ServerId { get; }
    public string Name => Definition.Name;

    /// <summary>False for nordic-db (down since 03:12) and after POST /api/e2e/disconnect-server.</summary>
    public bool Online { get; set; }

    /// <summary>Docker mode reported in hello; the enrol key's choice for servers from POST /api/e2e/enrol-fake-agent.</summary>
    public string? DockerMode { get; init; }

    public double Cpu { get; private set; }
    public double Mem { get; private set; }
    public double[] PerCore { get; }
    public double[] Load { get; }
    public double SwapPct { get; }
    public long UptimeSeconds { get; private set; }
    public long BootTime { get; }
    public List<string> FailedUnits { get; }
    public List<FakeMount> Mounts { get; }
    public List<FakeIface> Ifaces { get; }
    public List<FakeContainer> Containers { get; }
    public List<FakeProcess> Processes { get; }
    public long RamBytes => Definition.RamGb * GB;

    public Hello Hello() => new(
        1,
        null,
        null,
        Name,
        "0.1.0",
        new OsInfo("ubuntu", Definition.Ubuntu, DemoData.PrettyNameFor(Definition.Ubuntu)),
        DemoData.KernelFor(Definition.Ubuntu),
        "amd64",
        Definition.Cores,
        RamBytes,
        BootTime,
        DockerMode ?? (Definition.Containers > 0 ? "socket" : "none"));

    /// <summary>One second of drift (simulate() in glimtData.js).</summary>
    public void Tick()
    {
        var d = Definition;
        Cpu = Clamp(Cpu + Rnd(-4, 4) + (d.CpuBase - Cpu) * 0.15, 1, 99);
        if (d.CpuBase >= 90)
        {
            Cpu = Clamp(Cpu, 93, 99);
        }

        Mem = Clamp(Mem + Rnd(-0.4, 0.4) + (d.MemBase - Mem) * 0.05, 1, 99);
        for (var i = 0; i < PerCore.Length; i++)
        {
            PerCore[i] = Clamp(PerCore[i] + Rnd(-10, 10) + (Cpu - PerCore[i]) * 0.3, 0, 100);
        }

        var l = Cpu / 100 * d.Cores;
        Load[0] = l * Rnd(0.9, 1.1);
        Load[1] = l * 0.92;
        Load[2] = l * 0.85;
        foreach (var i in Ifaces)
        {
            i.InMBps = Clamp(i.InMBps + Rnd(-2, 2), 0.1, 60);
            i.OutMBps = Clamp(i.OutMBps + Rnd(-0.5, 0.5), 0.05, 20);
        }

        foreach (var c in Containers)
        {
            if (c.State == "exited")
            {
                continue;
            }

            c.CpuPct = Clamp(c.CpuPct + Rnd(-1.5, 1.5), 0.1, 60);
            c.MemMb = Clamp(c.MemMb + Rnd(-6, 6), 10, c.LimitMb > 0 ? c.LimitMb : 2000);
            c.NetIn = Clamp(c.NetIn + Rnd(-0.3, 0.3), 0, 10);
            c.NetOut = Clamp(c.NetOut + Rnd(-0.1, 0.1), 0, 5);
        }

        foreach (var p in Processes)
        {
            p.CpuPct = Clamp(p.CpuPct + Rnd(-2, 2) + (p.CpuBase - p.CpuPct) * 0.2, 0, 99);
        }

        foreach (var m in Mounts)
        {
            m.ReadMBps = Clamp(m.ReadMBps + Rnd(-3, 3), 0, 200);
            m.WriteMBps = Clamp(m.WriteMBps + Rnd(-5, 5), 0, 400);
        }

        UptimeSeconds++;
    }

    public Snapshot Snapshot(long ts) => new(
        ts,
        Host(),
        Containers.Select(c => new ContainerInfo(
            c.Id,
            c.Name,
            c.Image,
            ts - c.ImageAgeDays * 86_400_000L,
            c.State,
            c.State == "running" ? c.Health : "none",
            c.RestartCount,
            c.State == "exited" ? null : ts - c.UpSeconds * 1000,
            c.State == "exited" ? 0 : Round(c.CpuPct),
            c.State == "exited" ? 0 : (long)(c.MemMb * MB),
            c.LimitMb > 0 ? (long)(c.LimitMb * MB) : null,
            Round(c.NetIn * MB),
            Round(c.NetOut * MB),
            c.Ports,
            c.Mounts,
            _prefix)).ToList(),
        Services(),
        new MaintenanceInfo(
            Definition.Flags.Reboot,
            Definition.Flags.Reboot ? DemoData.RebootPackages : [],
            DemoData.Updates[Index],
            DemoData.SecurityUpdates[Index],
            ts - 600_000,
            true),
        Security(ts));

    public Agents.Protocol.Stream Stream(long ts) => new(
        ts,
        Host(),
        Containers.Select(c => new ContainerStats(
            c.Id,
            c.State == "exited" ? 0 : Round(c.CpuPct),
            c.State == "exited" ? 0 : (long)(c.MemMb * MB),
            c.LimitMb > 0 ? (long)(c.LimitMb * MB) : null,
            Round(c.NetIn * MB),
            Round(c.NetOut * MB),
            c.State)).ToList(),
        Processes.OrderByDescending(p => p.CpuPct).Select(p => new ProcessInfo(p.Pid, p.Name, p.User, Round(p.CpuPct), (long)(p.MemMb * MB), p.StartedAt, p.Cmdline)).ToList(),
        new ProcessTotals(180 + Index * 7 + Processes.Count, 2, 0));

    /// <summary>Buffer point i of n for the last 24 h (series() in glimtData.js: sine + noise, a spike on api-prod and web-02).</summary>
    public PointInput HistoryPoint(int i, int n, long ts)
    {
        var d = Definition;
        var spikeAt = Index == 2 ? n * 36 / 288 : Index == 1 ? n * 150 / 288 : (int?)null;
        var cpu = Series(d.CpuBase, d.CpuBase > 90 ? 2 : 12, i, n, spikeAt);
        var mem = Series(d.MemBase, 4, i, n, null);
        var disks = Mounts.Select(m => new DiskInput(m.Path, (float)Clamp(m.Pct + Rnd(-0.5, 0.5), 0, 100))).ToList();
        var ifaces = Ifaces.Select(x => new IfaceInput(x.Name, (float)(Series(x.InMBps, x.InMBps / 2, i, n, null) * MB), (float)(Series(x.OutMBps, x.OutMBps / 2, i, n, null) * MB))).ToList();
        var containers = Containers.Select(c => new ContainerInput(
            c.Id,
            c.State == "exited" ? 0f : (float)Series(c.CpuPct, 8, i, n, null),
            c.State == "exited" ? 0f : (float)Series(c.LimitMb > 0 ? c.MemMb / c.LimitMb * 100 : c.MemMb / 2000 * 100, 5, i, n, null))).ToList();
        return new PointInput(ts, (float)cpu, (float)mem, (float)SwapPct, disks, ifaces, containers);
    }

    /// <summary>Lines for a demo log stream: journal sources from LOGT (filtered), container from CLOGT.</summary>
    public IEnumerable<LogLine> LogLines(LogStart request, long fromTs, int count)
    {
        if (request.Source == "container")
        {
            var container = Containers.FirstOrDefault(c => c.Id == request.Container || c.Name == request.Container);
            var lines = container is not null && DemoData.ContainerLogs.TryGetValue(container.Kind, out var rows) ? rows : ["(no such container)"];
            for (var i = 0; i < count; i++)
            {
                yield return new LogLine(fromTs + i * 1000, null, container?.Name ?? request.Container, i % 7 == 6 ? "warn" : "info", lines[i % lines.Length]);
            }

            yield break;
        }

        var category = DemoData.CategoryFor(request.Source);
        var table = DemoData.LogTable.Where(r => category is null || r.Category == category)
            .Where(r => request.Unit is null || r.Unit == request.Unit.Replace(".service", "", StringComparison.Ordinal))
            .Where(r => request.Priority switch { "err" => r.Priority == "err", "warn" => r.Priority is "err" or "warn", _ => true })
            .ToArray();
        if (table.Length == 0)
        {
            yield break;
        }

        for (var i = 0; i < count; i++)
        {
            var row = table[(i + Index) % table.Length];
            yield return new LogLine(fromTs + i * 1000, row.Unit, null, row.Priority, row.Message);
        }
    }

    private HostMetrics Host()
    {
        var memUsed = (long)(RamBytes * Mem / 100);
        var swapTotal = SwapPct > 0 ? 2 * GB : 0;
        return new HostMetrics(
            new CpuMetrics(Round(Cpu), Round(Cpu * 0.7), Round(Cpu * 0.22), Round(Cpu * 0.08), 0, PerCore.Select(Round).ToList()),
            Load.Select(l => Math.Round(l, 2)).ToList(),
            new MemMetrics(RamBytes, memUsed, RamBytes - memUsed - RamBytes / 20, RamBytes / 100, RamBytes / 25, swapTotal, (long)(swapTotal * SwapPct / 100)),
            UptimeSeconds,
            Mounts.Select(m => new MountMetrics(m.Path, m.Fs, m.Path == "/" ? "sda1" : "sdb1", m.TotalBytes, (long)(m.TotalBytes * m.Pct / 100), 5_242_880, (long)(5_242_880 * m.InodePct / 100), Round(m.ReadMBps * MB), Round(m.WriteMBps * MB))).ToList(),
            Ifaces.Select(i => new IfaceMetrics(i.Name, [i.Ip], Round(i.InMBps * MB), Round(i.OutMBps * MB))).ToList());
    }

    private ServicesInfo Services()
    {
        var reboot = Definition.Flags.Reboot;
        var units = new List<ServiceUnit>
        {
            new("nginx.service", "running", false),
            new("docker.service", "running", false),
            new("ssh.service", "running", reboot),
            new("cron.service", "running", false),
            new("fail2ban.service", "running", false),
            new("unattended-upgrades.service", "running", false),
            new("postgresql.service", Name.Contains("db", StringComparison.Ordinal) ? "running" : "stopped", false),
            new("redis-server.service", "running", false),
        };
        units.AddRange(FailedUnits.Select(f => new ServiceUnit(f, "failed", false)));
        units.Sort((a, b) => (a.State == "failed" ? 0 : 1).CompareTo(b.State == "failed" ? 0 : 1));
        return new ServicesInfo(units, FailedUnits.ToList(), reboot ? ["ssh.service"] : []);
    }

    private SecurityInfo Security(long ts)
    {
        var ports = new List<ListeningPort> { new(22, "tcp", "sshd", 812), new(80, "tcp", "nginx", 1182), new(443, "tcp", "nginx", 1182) };
        if (Name.Contains("db", StringComparison.Ordinal))
        {
            ports.Add(new ListeningPort(5432, "tcp", "postgres", 1037));
        }

        if (Definition.Containers > 3)
        {
            ports.Add(new ListeningPort(6379, "tcp", "docker-proxy", 2210));
            ports.Add(new ListeningPort(3000, "tcp", "node", 1000 + Index * 3));
        }

        var loggedIn = new List<LoggedInUser> { new("ole", "10.0.0.12", "pts/0", ts - 33 * 60_000) };
        if (Index % 4 == 0)
        {
            loggedIn.Add(new LoggedInUser("deploy", "51.13.88.201", "pts/1", ts - 12 * 60_000));
        }

        return new SecurityInfo(
            ports,
            loggedIn,
            new SshFailed(DemoData.SshFailedHour[Index], DemoData.SshFailedDay[Index],
            [
                new SshAttempt("root", "45.33.12.9", ts - 3 * 60_000),
                new SshAttempt("admin", "185.220.101.4", ts - 6 * 60_000),
                new SshAttempt("ubuntu", "103.44.9.77", ts - 11 * 60_000),
            ]),
            new FirewallInfo("active", Index % 5 != 1 ? "active" : "inactive", DemoData.Fail2banBanned[Index], DemoData.Fail2banBanned[Index] * 3));
    }

    private double Series(double @base, double amp, int i, int n, int? spikeAt)
    {
        var v = @base + amp * Math.Sin((double)i / n * Math.PI * 2 - 1.2) + Rnd(-3, 3);
        if (spikeAt is { } s && Math.Abs(i - s) < n * 8 / 288)
        {
            v += 45 * (1 - Math.Abs(i - s) / (n * 8.0 / 288));
        }

        return Clamp(v, 1, 99);
    }

    private double Rnd(double a, double b) => a + _rng.NextDouble() * (b - a);

    private static double Clamp(double v, double a, double b) => Math.Max(a, Math.Min(b, v));

    private static double Round(double v) => Math.Round(v, 1);

    private static string ContainerId(string key) => Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(key)))[..12];
}

public sealed class FakeMount(string path, string fs, long totalBytes, double pct, double inodePct, double readMBps, double writeMBps)
{
    public string Path { get; } = path;
    public string Fs { get; } = fs;
    public long TotalBytes { get; } = totalBytes;
    public double Pct { get; } = pct;
    public double InodePct { get; } = inodePct;
    public double ReadMBps { get; set; } = readMBps;
    public double WriteMBps { get; set; } = writeMBps;
}

public sealed class FakeIface(string name, string ip, double inMBps, double outMBps)
{
    public string Name { get; } = name;
    public string Ip { get; } = ip;
    public double InMBps { get; set; } = inMBps;
    public double OutMBps { get; set; } = outMBps;
}

public sealed class FakeContainer
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Kind { get; init; }
    public required string Image { get; init; }
    public required string State { get; init; }
    public double CpuPct { get; set; }
    public double MemMb { get; set; }
    public int LimitMb { get; init; }
    public int RestartCount { get; init; }
    public int ImageAgeDays { get; init; }
    public required string Health { get; init; }
    public long UpSeconds { get; init; }
    public double NetIn { get; set; }
    public double NetOut { get; set; }
    public required string[] Ports { get; init; }
    public required string[] Mounts { get; init; }
}

public sealed class FakeProcess
{
    public int Pid { get; init; }
    public required string Name { get; init; }
    public required string User { get; init; }
    public double CpuBase { get; init; }
    public double CpuPct { get; set; }
    public double MemMb { get; init; }
    public required string Cmdline { get; init; }
    public long StartedAt { get; init; }
}
