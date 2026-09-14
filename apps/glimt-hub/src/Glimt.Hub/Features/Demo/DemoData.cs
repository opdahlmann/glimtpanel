namespace Glimt.Hub.Features.Demo;

/// <summary>Flags from the design's DEFS table (glimtData.js).</summary>
public sealed record DemoFlags(
    bool CpuHigh = false,
    bool Reboot = false,
    string? Failed = null,
    string? RestartLoop = null,
    string? DownAt = null,
    bool Paused = false,
    bool Eol = false);

public sealed record DemoMount(string Path, string Fs, int TotalGb, int Pct);

/// <summary>One of the 16 demo servers: name, tags, cores, RAM, Ubuntu version, cpu/mem base, mounts, container count, flags.</summary>
public sealed record DemoDefinition(
    string Name,
    string[] Tags,
    int Cores,
    int RamGb,
    string Ubuntu,
    double CpuBase,
    double MemBase,
    DemoMount[] Mounts,
    int Containers,
    DemoFlags Flags);

public sealed record DemoLogRow(string Priority, string Unit, string Message, string Category);

/// <summary>The demo data tables, ported one to one from design/glimtData.js (IMPLEMENTERINGSPLAN step 2.10).</summary>
public static class DemoData
{
    public const string DemoUserEmail = "demo@glimtpanel.com";
    public const string ServerIdPrefix = "demo-";

    public static readonly DemoDefinition[] Definitions =
    [
        new("web-01", ["prod"], 4, 8, "24.04", 34, 62, [new("/", "ext4", 80, 41), new("/var", "ext4", 200, 66)], 8, new()),
        new("web-02", ["prod"], 4, 8, "24.04", 48, 61, [new("/", "ext4", 80, 92)], 6, new()),
        new("api-prod", ["prod"], 8, 16, "24.04", 96, 71, [new("/", "ext4", 160, 58)], 9, new(CpuHigh: true)),
        new("db-prod", ["prod"], 8, 32, "22.04", 28, 79, [new("/", "ext4", 80, 33), new("/data", "xfs", 1000, 71)], 1, new(Reboot: true)),
        new("worker-01", ["prod"], 4, 8, "24.04", 44, 52, [new("/", "ext4", 80, 38)], 5, new(Failed: "cron-sync.service")),
        new("cache-01", ["prod"], 2, 4, "24.04", 12, 84, [new("/", "ext4", 40, 21)], 2, new()),
        new("staging-web", ["staging"], 2, 4, "24.04", 18, 44, [new("/", "ext4", 80, 55)], 7, new()),
        new("staging-db", ["staging"], 2, 8, "24.04", 9, 62, [new("/", "ext4", 80, 47), new("/data", "xfs", 200, 12)], 1, new()),
        new("acme-app", ["client-a"], 4, 8, "24.04", 38, 58, [new("/", "ext4", 80, 66)], 11, new(RestartLoop: "acme-worker")),
        new("acme-db", ["client-a"], 4, 16, "22.04", 21, 74, [new("/", "ext4", 80, 29), new("/data", "xfs", 500, 83)], 1, new()),
        new("nordic-shop", ["client-b"], 4, 8, "26.04", 52, 49, [new("/", "ext4", 120, 44)], 9, new()),
        new("nordic-db", ["client-b"], 4, 16, "24.04", 0, 0, [new("/", "ext4", 80, 52), new("/data", "xfs", 500, 61)], 1, new(DownAt: "03:12")),
        new("nas", ["homelab"], 4, 16, "24.04", 6, 35, [new("/", "ext4", 60, 40), new("/mnt/pool", "zfs", 8000, 86)], 4, new()),
        new("pi-hole", ["homelab"], 4, 4, "24.04", 3, 28, [new("/", "ext4", 32, 19)], 2, new()),
        new("media", ["homelab"], 6, 16, "24.04", 14, 41, [new("/", "ext4", 120, 58)], 5, new(Paused: true)),
        new("backup", ["homelab"], 2, 4, "20.04", 4, 23, [new("/", "ext4", 40, 31), new("/backup", "ext4", 4000, 78)], 0, new(Eol: true)),
    ];

    /// <summary>
    /// The three demo container nodes (step 12.11): acme-backend is linked to web-02's api container with a health
    /// check and two TCP checks; acme-frontend runs without limits; edge-worker has no cgroup (approx) and sleeps 02–06.
    /// </summary>
    public static readonly DemoNodeDefinition[] Nodes =
    [
        new("acme-backend", ["prod", "client-a"], "ghcr.io/acme/backend:2.4.1", 2, 1024, true, "http://127.0.0.1:3000/healthz", [new("db", "postgres:5432"), new("cache", "redis:6379")], "web-02", "web-api", null, null, 31, 58, ["/var/log/app/app.log", "/var/log/app/access.log"], [3000]),
        new("acme-frontend", ["prod", "client-a"], "ghcr.io/acme/frontend:1.9.0", 0, 0, true, "http://127.0.0.1:8080/", [], null, null, null, null, 9, 22, ["/var/log/nginx/access.log"], [8080]),
        new("edge-worker", ["edge"], "ghcr.io/acme/edge-worker:0.7.3", 1, 512, false, null, [new("queue", "rabbit:5672")], null, null, "02:00", "06:00", 17, 44, [], [9100]),
    ];

    public static readonly string[] ContainerKinds = ["web", "api", "db", "redis", "worker", "proxy", "cron", "mail", "search", "queue", "cache"];

    public static readonly Dictionary<string, string> Images = new(StringComparer.Ordinal)
    {
        ["web"] = "nginx:1.27",
        ["api"] = "node:22-alpine",
        ["db"] = "postgres:16",
        ["redis"] = "redis:7-alpine",
        ["worker"] = "ghcr.io/acme/worker:2.4.1",
        ["proxy"] = "traefik:v3.1",
        ["cron"] = "alpine:3.20",
        ["mail"] = "mailhog/mailhog",
        ["search"] = "meilisearch:v1.10",
        ["queue"] = "rabbitmq:3-management",
        ["cache"] = "redis:7-alpine",
    };

    public static readonly (string Name, string User)[] Processes =
    [
        ("node", "app"), ("postgres", "postgres"), ("nginx", "www-data"), ("redis-server", "redis"), ("dockerd", "root"),
        ("containerd", "root"), ("systemd-journald", "root"), ("sshd", "root"), ("php-fpm", "www-data"), ("python3", "deploy"),
        ("fail2ban-server", "root"), ("glimt-agent", "glimt"),
    ];

    public static readonly int[] ProcessMemMb = [812, 1450, 64, 210, 120, 48, 32, 9, 96, 180, 40, 12];

    public static readonly Dictionary<string, string> Commands = new(StringComparer.Ordinal)
    {
        ["node"] = "node /srv/app/dist/server.js --port 3000",
        ["postgres"] = "postgres: checkpointer",
        ["nginx"] = "nginx: worker process",
        ["redis-server"] = "redis-server *:6379",
        ["dockerd"] = "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock",
        ["containerd"] = "/usr/bin/containerd",
        ["systemd-journald"] = "/lib/systemd/systemd-journald",
        ["sshd"] = "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups",
        ["php-fpm"] = "php-fpm: pool www",
        ["python3"] = "python3 /opt/sync/run.py --interval 60",
        ["fail2ban-server"] = "/usr/bin/python3 /usr/bin/fail2ban-server -xf start",
        ["glimt-agent"] = "/usr/local/bin/glimt-agent",
    };

    /// <summary>Uptime per server in seconds ("12d 4h" …; nordic-db has none).</summary>
    public static readonly long[] UptimeSeconds =
    [
        Days(12, 4), Days(41, 2), Days(6, 19), Days(98, 3), Days(3, 4), Days(21, 0), Days(7, 5), Days(15, 2),
        Days(2, 9), Days(63, 1), Days(9, 1), 0, Days(120, 3), Days(200, 7), Days(4, 0), Days(311, 5),
    ];

    public static readonly int[] Updates = [3, 7, 0, 12, 2, 1, 4, 0, 9, 5, 2, 0, 3, 1, 0, 31];
    public static readonly int[] SecurityUpdates = [1, 2, 0, 4, 0, 0, 1, 0, 3, 2, 0, 0, 1, 0, 0, 14];
    public static readonly int[] SshFailedHour = [14, 3, 0, 22, 1, 0, 2, 0, 8, 4, 31, 0, 0, 0, 0, 2];
    public static readonly int[] SshFailedDay = [231, 44, 12, 318, 19, 3, 27, 5, 140, 61, 412, 0, 0, 2, 0, 39];
    public static readonly int[] Fail2banBanned = [42, 0, 3, 88, 1, 0, 5, 0, 12, 7, 120, 0, 0, 0, 0, 9];

    public static readonly string[] ContainerAges = ["3d 4h", "12d 1h", "6h 12m", "28d 2h", "2d 9h", "9d 0h"];
    public static readonly int[] ContainerImageAgeDays = [3, 41, 120, 9, 230, 17];

    public static readonly string[] RebootPackages = ["linux-image-6.8.0-45-generic", "libssl3"];

    /// <summary>LOGT: priority, unit, message, category (sys, auth, kern, web, pkg, fw).</summary>
    public static readonly DemoLogRow[] LogTable =
    [
        new("info", "systemd", "Started Daily apt upgrade and clean activities.", "sys"),
        new("info", "sshd", "Accepted publickey for ole from 10.0.0.12 port 51422 ssh2: ED25519 SHA256:k9QmR2…", "auth"),
        new("warn", "sshd", "Failed password for invalid user admin from 185.220.101.4 port 40122 ssh2", "auth"),
        new("err", "kernel", "Out of memory: Killed process 21833 (node) total-vm:2140312kB, anon-rss:812444kB", "kern"),
        new("info", "dockerd", "Container acme-worker exited with code 1, restarting (attempt 7)", "sys"),
        new("info", "nginx", "10.0.0.4 - - \"GET /api/health HTTP/1.1\" 200 17 \"-\" \"kube-probe/1.30\"", "web"),
        new("warn", "kernel", "EXT4-fs warning (device sda1): ext4_dx_add_entry: Directory index full!", "kern"),
        new("info", "sudo", "ole : TTY=pts/0 ; PWD=/home/ole ; USER=root ; COMMAND=/usr/bin/systemctl restart nginx", "auth"),
        new("info", "cron", "(root) CMD (/opt/backup/run.sh)", "sys"),
        new("err", "systemd", "cron-sync.service: Main process exited, code=exited, status=1/FAILURE", "sys"),
        new("info", "unattended-upgrades", "Packages that will be upgraded: libssl3 openssl", "pkg"),
        new("info", "fail2ban", "[sshd] Ban 45.33.12.9", "fw"),
        new("warn", "postgres", "checkpoints are occurring too frequently (12 seconds apart)", "sys"),
        new("info", "systemd", "Reloading OpenBSD Secure Shell server.", "sys"),
        new("info", "ufw", "[UFW BLOCK] IN=eth0 OUT= SRC=103.44.9.77 DST=10.0.1.12 PROTO=TCP DPT=23", "fw"),
        new("err", "nginx", "2026/09/09 08:11:02 [error] 1182#1182: *44 upstream timed out (110) while reading response header from upstream, client: 84.212.1.9", "web"),
        new("info", "apt", "install libssl3:amd64 3.0.13-0ubuntu3.4 → 3.0.13-0ubuntu3.5", "pkg"),
        new("warn", "kernel", "ata1.00: exception Emask 0x0 SAct 0x0 SErr 0x0 action 0x6 frozen", "kern"),
    ];

    /// <summary>CLOGT: container log lines per kind.</summary>
    public static readonly Dictionary<string, string[]> ContainerLogs = new(StringComparer.Ordinal)
    {
        ["web"] = ["GET / 200 12ms", "GET /assets/app.js 304 1ms", "POST /api/login 200 84ms", "GET /health 200 0ms"],
        ["api"] = ["request completed id=8f3k path=/v1/orders status=200 dur=41ms", "cache miss key=user:1182", "request completed id=8f3l path=/v1/me status=200 dur=9ms"],
        ["db"] = ["LOG:  checkpoint complete: wrote 412 buffers (2.5%)", "LOG:  automatic vacuum of table \"public.orders\""],
        ["redis"] = ["* Background saving terminated with success", "* 1 changes in 3600 seconds. Saving..."],
        ["worker"] = ["Error: connect ECONNREFUSED 172.18.0.4:6379", "    at TCPConnectWrap.afterConnect [as oncomplete]", "process exited with code 1"],
        ["proxy"] = ["level=info msg=\"Router web@docker updated\""],
        ["cron"] = ["run: /scripts/rotate.sh ok"],
        ["mail"] = ["[SMTP] Binding to address: 0.0.0.0:1025"],
        ["search"] = ["INFO  actix_web::middleware::logger: 172.18.0.3 \"GET /health\" 200 0.000123"],
        ["queue"] = ["accepting AMQP connection <0.812.0> (172.18.0.5:41230 -> 172.18.0.2:5672)"],
        ["cache"] = ["* Ready to accept connections tcp"],
    };

    /// <summary>Which log table categories a logStart source maps to (journal = everything).</summary>
    public static string? CategoryFor(string source) => source switch
    {
        "auth" => "auth",
        "kernel" => "kern",
        "packages" => "pkg",
        "web" => "web",
        "firewall" => "fw",
        _ => null,
    };

    public static string KernelFor(string ubuntu) => ubuntu switch
    {
        "26.04" => "7.0.0-14-generic",
        "24.04" => "6.8.0-45-generic",
        "22.04" => "5.15.0-118-generic",
        _ => "5.4.0-190-generic",
    };

    public static string PrettyNameFor(string ubuntu) => ubuntu switch
    {
        "26.04" => "Ubuntu 26.04 LTS",
        "24.04" => "Ubuntu 24.04.3 LTS",
        "22.04" => "Ubuntu 22.04.5 LTS",
        _ => "Ubuntu 20.04.6 LTS",
    };

    /// <summary>"3d 4h", "6h 12m", "41s" → seconds.</summary>
    public static long ParseAge(string text)
    {
        long seconds = 0;
        foreach (var part in text.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var number = long.Parse(part[..^1], System.Globalization.CultureInfo.InvariantCulture);
            seconds += part[^1] switch
            {
                'd' => number * 86_400,
                'h' => number * 3_600,
                'm' => number * 60,
                _ => number,
            };
        }

        return seconds;
    }

    private static long Days(int days, int hours) => days * 86_400L + hours * 3_600L;
}
