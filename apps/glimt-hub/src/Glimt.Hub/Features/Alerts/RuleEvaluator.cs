using System.Globalization;
using Glimt.Hub.Features.Agents.Protocol;

namespace Glimt.Hub.Features.Alerts;

/// <summary>One rule instance whose condition is true right now: the key (mount, container, unit; empty for host rules) and the detail text.</summary>
public sealed record RuleObservation(string Rule, string Key, string Detail);

/// <summary>
/// Restart-loop detection needs memory between snapshots: the last state per container and the restart counts seen
/// in the last window. One tracker per server, owned by the engine.
/// </summary>
public sealed class ContainerTracker
{
    private sealed class Track
    {
        public string Name = "";
        public string LastState = "";
        public bool StoppedSinceRunning;
        public readonly List<(DateTimeOffset At, int Restarts)> History = [];
    }

    private readonly Dictionary<string, Track> _tracks = new(StringComparer.Ordinal);

    /// <summary>Feeds one snapshot and returns the containers that are stopped-after-running, restarting, or restarted more than <paramref name="threshold"/> times within <paramref name="window"/>.</summary>
    public IReadOnlyList<RuleObservation> Observe(IReadOnlyList<ContainerInfo>? containers, DateTimeOffset now, double threshold, TimeSpan window)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<RuleObservation>();
        foreach (var c in containers ?? [])
        {
            seen.Add(c.Id);
            if (!_tracks.TryGetValue(c.Id, out var track))
            {
                track = new Track();
                _tracks[c.Id] = track;
            }

            track.Name = c.Name;
            var state = c.State;
            if (state == "running")
            {
                track.StoppedSinceRunning = false;
            }
            else if (track.LastState == "running" && state is "exited" or "dead" or "stopped")
            {
                track.StoppedSinceRunning = true;
            }

            track.LastState = state;
            track.History.Add((now, c.RestartCount ?? 0));
            track.History.RemoveAll(h => now - h.At > window);
            var increased = track.History.Count == 0 ? 0 : track.History[^1].Restarts - track.History.Min(h => h.Restarts);

            var windowMinutes = ((int)window.TotalMinutes).ToString(CultureInfo.InvariantCulture);
            if (track.StoppedSinceRunning)
            {
                result.Add(new RuleObservation(AlertRuleIds.ContRestart, c.Name, $"{c.Name} · stopped"));
            }
            else if (increased > threshold)
            {
                result.Add(new RuleObservation(AlertRuleIds.ContRestart, c.Name, $"{c.Name} · {increased} restarts / {windowMinutes} min"));
            }
            else if (state == "restarting")
            {
                result.Add(new RuleObservation(AlertRuleIds.ContRestart, c.Name, $"{c.Name} · restarting"));
            }
        }

        foreach (var gone in _tracks.Keys.Where(id => !seen.Contains(id)).ToList())
        {
            _tracks.Remove(gone);
        }

        return result;
    }
}

/// <summary>The snapshot-driven rules as pure functions over one snapshot (IMPLEMENTERINGSPLAN 4.6). server_down lives in the engine's sweep.</summary>
public static class RuleEvaluator
{
    public static IReadOnlyList<RuleObservation> Evaluate(Snapshot snapshot, ServerAlertConfig config, ContainerTracker containers, DateTimeOffset now)
    {
        var result = new List<RuleObservation>();
        var host = snapshot.Host;

        var disk = config.Rule(AlertRuleIds.DiskFull);
        if (disk.Enabled && disk.Threshold is { } diskThreshold)
        {
            foreach (var mount in host.Mounts ?? [])
            {
                var pct = mount.Total > 0 ? mount.Used * 100.0 / mount.Total : 0;
                if (pct >= diskThreshold)
                {
                    result.Add(new RuleObservation(AlertRuleIds.DiskFull, mount.Path, $"{mount.Path} · {Pct(pct)} %"));
                }
            }
        }

        var mem = config.Rule(AlertRuleIds.MemPressure);
        if (mem.Enabled && mem.Threshold is { } memThreshold && host.Mem.Total > 0)
        {
            var pct = host.Mem.Used * 100.0 / host.Mem.Total;
            if (pct >= memThreshold)
            {
                result.Add(new RuleObservation(AlertRuleIds.MemPressure, "", $"{Pct(pct)} % · {Minutes(mem.DurationSec)} min"));
            }
        }

        var cpu = config.Rule(AlertRuleIds.CpuSat);
        if (cpu.Enabled && cpu.Threshold is { } cpuThreshold && host.Cpu.Total >= cpuThreshold)
        {
            result.Add(new RuleObservation(AlertRuleIds.CpuSat, "", $"{Pct(host.Cpu.Total)} % · {Minutes(cpu.DurationSec)} min"));
        }

        var cont = config.Rule(AlertRuleIds.ContRestart);
        if (cont.Enabled)
        {
            result.AddRange(containers.Observe(snapshot.Containers, now, cont.Threshold ?? 3, TimeSpan.FromSeconds(cont.DurationSec ?? 600)));
        }
        else
        {
            containers.Observe(snapshot.Containers, now, double.MaxValue, TimeSpan.FromSeconds(600));
        }

        var svc = config.Rule(AlertRuleIds.SvcFailed);
        if (svc.Enabled && snapshot.Services is { } services)
        {
            var failed = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var unit in services.Units ?? [])
            {
                if (unit.State == "failed")
                {
                    failed.Add(unit.Name);
                }
            }

            foreach (var name in services.Failed ?? [])
            {
                failed.Add(name);
            }

            foreach (var name in failed)
            {
                result.Add(new RuleObservation(AlertRuleIds.SvcFailed, name, name));
            }
        }

        var reboot = config.Rule(AlertRuleIds.Reboot);
        if (reboot.Enabled && snapshot.Maintenance?.RebootRequired == true)
        {
            var pkgs = snapshot.Maintenance.RebootPkgs ?? [];
            var detail = pkgs.Count == 0 ? "" : string.Join(", ", pkgs.Take(3)) + (pkgs.Count > 3 ? " …" : "");
            result.Add(new RuleObservation(AlertRuleIds.Reboot, "", detail));
        }

        return result;
    }

    /// <summary>"last seen 03:12" in the owner's time zone, the detail of a server_down alert.</summary>
    public static string ServerDownDetail(DateTimeOffset lastSeen, string timezone)
    {
        var local = lastSeen;
        try
        {
            local = TimeZoneInfo.ConvertTime(lastSeen, TimeZoneInfo.FindSystemTimeZoneById(timezone));
        }
        catch (TimeZoneNotFoundException)
        {
            // keep UTC
        }
        catch (InvalidTimeZoneException)
        {
            // keep UTC
        }

        return "last seen " + local.ToString("HH:mm", CultureInfo.InvariantCulture);
    }

    private static string Pct(double value) => Math.Round(value).ToString(CultureInfo.InvariantCulture);

    private static string Minutes(int? seconds) => ((seconds ?? 0) / 60).ToString(CultureInfo.InvariantCulture);
}
