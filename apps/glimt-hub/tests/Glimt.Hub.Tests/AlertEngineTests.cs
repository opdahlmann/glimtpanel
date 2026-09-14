using Glimt.Hub.Features.Alerts;

namespace Glimt.Hub.Tests;

/// <summary>Every rule with a spooled clock (IMPLEMENTERINGSPLAN step 7.1): fires after the right duration and not before, resolves, reminds, silence, overrides, mute, restart window, restore.</summary>
public sealed class AlertEngineTests
{
    [Fact]
    public async Task Disk_full_fires_at_once_per_mount_and_resolves_when_below()
    {
        var h = new AlertEngineHarness();
        var web = h.Server("s1", "web-02");
        await h.TickAsync(web, AlertEngineHarness.Snapshot(diskPct: 92));

        var fired = Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        Assert.Equal(AlertRuleIds.DiskFull, fired.Alert.Rule);
        Assert.Equal("/", fired.Alert.Key);
        Assert.Equal("/ · 92 %", fired.Alert.Detail);
        Assert.Equal(AlertSeverities.Critical, fired.Alert.Severity);
        Assert.Equal("web-02", fired.ServerName);
        Assert.Equal(AlertEngineHarness.OwnerId, fired.OwnerId);
        Assert.False(fired.Quiet);
        Assert.Equal(new AlertSummary(1, AlertSeverities.Critical), h.Counts.Get("s1"));
        Assert.Single(h.Store.Alerts);

        await h.TickAsync(web, AlertEngineHarness.Snapshot(diskPct: 92));
        Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));

        await h.TickAsync(web, AlertEngineHarness.Snapshot(diskPct: 70));
        var resolved = Assert.Single(h.Sink.OfKind(AlertEventKinds.Resolved));
        Assert.Equal(fired.Alert.Id, resolved.Alert.Id);
        Assert.Equal(AlertStates.Resolved, h.Store.Alerts[0].State);
        Assert.NotNull(h.Store.Alerts[0].ResolvedAt);
        Assert.Equal(0, h.Counts.Get("s1").Count);
    }

    [Fact]
    public async Task Memory_pressure_needs_five_minutes_and_cpu_fifteen()
    {
        var h = new AlertEngineHarness();
        var s = h.Server("s1", "api");
        // 9 snapshots = 4.5 min: still pending.
        for (var i = 0; i < 10; i++)
        {
            await h.TickAsync(s, AlertEngineHarness.Snapshot(memPct: 97, cpu: 98, diskPct: 10));
        }

        Assert.Empty(h.Sink.Events);
        // The 11th snapshot arrives 300 s after the first: memory fires, cpu does not.
        await h.TickAsync(s, AlertEngineHarness.Snapshot(memPct: 97, cpu: 98, diskPct: 10));
        var mem = Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        Assert.Equal(AlertRuleIds.MemPressure, mem.Alert.Rule);
        Assert.Equal("97 % · 5 min", mem.Alert.Detail);
        Assert.Equal(AlertSeverities.Warning, mem.Alert.Severity);

        for (var i = 0; i < 19; i++)
        {
            await h.TickAsync(s, AlertEngineHarness.Snapshot(memPct: 97, cpu: 98, diskPct: 10));
        }

        Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        await h.TickAsync(s, AlertEngineHarness.Snapshot(memPct: 97, cpu: 98, diskPct: 10));
        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Fired).Length);
        Assert.Equal(AlertRuleIds.CpuSat, h.Sink.Last.Alert.Rule);
        Assert.Equal("98 % · 15 min", h.Sink.Last.Alert.Detail);

        // A dip resets the pending window: 3 min high, 30 s low, 3 min high → nothing.
        await h.TickAsync(s, AlertEngineHarness.Snapshot(memPct: 50, cpu: 10, diskPct: 10));
        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Resolved).Length);
        for (var i = 0; i < 6; i++)
        {
            await h.TickAsync(s, AlertEngineHarness.Snapshot(memPct: 97, diskPct: 10));
        }

        await h.TickAsync(s, AlertEngineHarness.Snapshot(memPct: 50, diskPct: 10));
        for (var i = 0; i < 6; i++)
        {
            await h.TickAsync(s, AlertEngineHarness.Snapshot(memPct: 97, diskPct: 10));
        }

        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Fired).Length);
    }

    [Fact]
    public async Task Container_stopped_after_running_and_restart_loop_within_ten_minutes()
    {
        var h = new AlertEngineHarness();
        var s = h.Server("s1", "acme-app");
        JsonContainers(out var running, out var stopped);
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10, containers: [running("web", 0), running("worker", 0)]));
        Assert.Empty(h.Sink.Events);

        // web stops after having run: fires with "stopped".
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10, containers: [stopped("web", 0), running("worker", 1)]));
        var f = Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        Assert.Equal("web", f.Alert.Key);
        Assert.Equal("web · stopped", f.Alert.Detail);

        // worker: 4 restarts within 10 minutes (> 3) → loop; 3 is not enough.
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10, containers: [stopped("web", 0), running("worker", 3)]));
        Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10, containers: [stopped("web", 0), running("worker", 4)]));
        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Fired).Length);
        Assert.Equal("worker · 4 restarts / 10 min", h.Sink.Last.Alert.Detail);

        // web runs again → resolved. Worker stays flat for 10 minutes → the window empties and it resolves too.
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10, containers: [running("web", 0), running("worker", 4)]));
        Assert.Single(h.Sink.OfKind(AlertEventKinds.Resolved));
        for (var i = 0; i < 21; i++)
        {
            await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10, containers: [running("web", 0), running("worker", 4)]));
        }

        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Resolved).Length);

        // A container that was never seen running and is exited from the start does not fire.
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10, containers: [running("web", 0), running("worker", 4), stopped("cron", 0)]));
        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Fired).Length);
    }

    private static void JsonContainers(out Func<string, int, System.Text.Json.Nodes.JsonObject> running, out Func<string, int, System.Text.Json.Nodes.JsonObject> stopped)
    {
        running = (name, restarts) => AlertEngineHarness.Container(name, "running", restarts);
        stopped = (name, restarts) => AlertEngineHarness.Container(name, "exited", restarts);
    }

    [Fact]
    public async Task Service_failed_and_reboot_required_follow_the_snapshot()
    {
        var h = new AlertEngineHarness();
        var s = h.Server("s1", "worker-01");
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10, reboot: true, failedUnits: ["cron-sync.service"]));
        var fired = h.Sink.OfKind(AlertEventKinds.Fired);
        Assert.Equal(2, fired.Length);
        var svc = fired.Single(e => e.Alert.Rule == AlertRuleIds.SvcFailed);
        Assert.Equal("cron-sync.service", svc.Alert.Key);
        Assert.Equal("cron-sync.service", svc.Alert.Detail);
        var reboot = fired.Single(e => e.Alert.Rule == AlertRuleIds.Reboot);
        Assert.Equal(AlertSeverities.Info, reboot.Alert.Severity);
        Assert.Contains("linux-image", reboot.Alert.Detail);
        Assert.Equal(new AlertSummary(2, AlertSeverities.Warning), h.Counts.Get("s1"));

        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10, reboot: false, failedUnits: []));
        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Resolved).Length);
        Assert.Equal(0, h.Counts.Get("s1").Count);
    }

    [Fact]
    public async Task Server_down_fires_after_120_seconds_and_resolves_when_the_agent_is_back()
    {
        var h = new AlertEngineHarness();
        var s = h.Server("s1", "nordic-db");
        await h.Engine.SweepAsync(CancellationToken.None);
        Assert.Empty(h.Sink.Events);

        s.Detach("link-s1");
        h.Clock.Advance(TimeSpan.FromSeconds(119));
        await h.Engine.SweepAsync(CancellationToken.None);
        Assert.Empty(h.Sink.Events);

        h.Clock.Advance(TimeSpan.FromSeconds(1));
        await h.Engine.SweepAsync(CancellationToken.None);
        var fired = Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        Assert.Equal(AlertRuleIds.ServerDown, fired.Alert.Rule);
        Assert.Equal("last seen 08:00", fired.Alert.Detail);
        Assert.Equal(AlertSeverities.Critical, fired.Alert.Severity);

        await h.Engine.SweepAsync(CancellationToken.None);
        Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));

        s.Attach(new NullAgentLink("link-s1b"), AlertEngineHarness.Hello("nordic-db"), h.Clock.GetUtcNow());
        await h.Engine.ServerUpAsync(s, CancellationToken.None);
        var resolved = Assert.Single(h.Sink.OfKind(AlertEventKinds.Resolved));
        Assert.Equal(fired.Alert.Id, resolved.Alert.Id);
    }

    [Fact]
    public async Task Reminder_after_24_hours_while_firing_and_not_for_info()
    {
        var h = new AlertEngineHarness();
        var s = h.Server("s1", "web-02");
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 92, reboot: true));
        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Fired).Length);

        h.Clock.Advance(TimeSpan.FromHours(23));
        await h.Engine.SweepAsync(CancellationToken.None);
        Assert.Empty(h.Sink.OfKind(AlertEventKinds.Reminder));

        h.Clock.Advance(TimeSpan.FromHours(1));
        await h.Engine.SweepAsync(CancellationToken.None);
        var reminder = Assert.Single(h.Sink.OfKind(AlertEventKinds.Reminder));
        Assert.Equal(AlertRuleIds.DiskFull, reminder.Alert.Rule);
        Assert.NotNull(h.Store.Alerts.Single(a => a.Rule == AlertRuleIds.DiskFull).LastReminderAt);

        await h.Engine.SweepAsync(CancellationToken.None);
        Assert.Single(h.Sink.OfKind(AlertEventKinds.Reminder));
        h.Clock.Advance(TimeSpan.FromHours(24));
        await h.Engine.SweepAsync(CancellationToken.None);
        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Reminder).Length);
    }

    [Fact]
    public async Task Silence_and_mute_make_events_quiet_but_keep_the_state_machine()
    {
        var h = new AlertEngineHarness();
        var s = h.Server("s1", "web-02");
        h.Servers.Docs["s1"].SilencedUntil = h.Clock.GetUtcNow().AddHours(1).UtcDateTime;
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 92));
        var fired = Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        Assert.True(fired.Quiet);
        Assert.Equal(1, h.Counts.Get("s1").Count);
        Assert.Single(h.Store.Alerts);

        // No reminder while silenced; after the silence ends the reminder goes out.
        h.Clock.Advance(TimeSpan.FromMinutes(30));
        h.Config.Invalidate("s1");
        h.Clock.Advance(TimeSpan.FromHours(24));
        await h.Engine.SweepAsync(CancellationToken.None);
        Assert.Single(h.Sink.OfKind(AlertEventKinds.Reminder));
        Assert.False(h.Sink.Last.Quiet);

        // Muted: the resolve is quiet too.
        h.Servers.Docs["s1"].AlertsMuted = true;
        h.Config.Invalidate("s1");
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 10));
        var resolved = Assert.Single(h.Sink.OfKind(AlertEventKinds.Resolved));
        Assert.True(resolved.Quiet);
    }

    [Fact]
    public async Task Account_threshold_and_server_override_change_when_rules_fire()
    {
        var h = new AlertEngineHarness();
        var s = h.Server("s1", "web-02");
        // Account: disk at 95 %; the example's 92 % is below.
        h.Store.Settings[AlertEngineHarness.OwnerId] = new AlertSettingsDocument
        {
            UserId = AlertEngineHarness.OwnerId,
            Rules = { [AlertRuleIds.DiskFull] = new RuleSettingDocument { Threshold = 95 } },
        };
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 92));
        Assert.Empty(h.Sink.Events);

        // Server override back to 90 → fires.
        h.Servers.Docs["s1"].AlertOverrides = new Dictionary<string, RuleSettingDocument> { [AlertRuleIds.DiskFull] = new() { Threshold = 90 } };
        h.Config.Invalidate("s1");
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 92));
        Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));

        // Rule disabled on the server → resolved quietly and never re-fires.
        h.Servers.Docs["s1"].AlertOverrides = new Dictionary<string, RuleSettingDocument> { [AlertRuleIds.DiskFull] = new() { Enabled = false } };
        h.Config.Invalidate("s1");
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 92));
        var resolved = Assert.Single(h.Sink.OfKind(AlertEventKinds.Resolved));
        Assert.True(resolved.Quiet);
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 92));
        Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
    }

    [Fact]
    public async Task Restored_alerts_are_firing_and_resolve_on_the_first_snapshot_that_disagrees()
    {
        var h = new AlertEngineHarness();
        var s = h.Server("s1", "web-02");
        var old = new AlertDocument { ServerId = "s1", OwnerId = AlertEngineHarness.OwnerId, Rule = AlertRuleIds.DiskFull, Key = "/", Severity = AlertSeverities.Critical, Detail = "/ · 92 %", FiredAt = h.Clock.GetUtcNow().AddHours(-2).UtcDateTime };
        var stale = new AlertDocument { ServerId = "s1", OwnerId = AlertEngineHarness.OwnerId, Rule = AlertRuleIds.SvcFailed, Key = "old.service", Severity = AlertSeverities.Warning, Detail = "old.service", FiredAt = h.Clock.GetUtcNow().AddHours(-3).UtcDateTime };
        h.Store.Alerts.AddRange([old, stale]);
        await h.Engine.RestoreAsync([old, stale], CancellationToken.None);
        Assert.Equal(new AlertSummary(2, AlertSeverities.Critical), h.Counts.Get("s1"));
        Assert.Equal(2, h.Engine.Firing("s1").Count);

        // Disk still 92 %: no new fire; the old service is fine: resolved.
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 92, failedUnits: []));
        Assert.Empty(h.Sink.OfKind(AlertEventKinds.Fired));
        var resolved = Assert.Single(h.Sink.OfKind(AlertEventKinds.Resolved));
        Assert.Equal(stale.Id, resolved.Alert.Id);
        Assert.Equal(1, h.Counts.Get("s1").Count);
        Assert.Single(h.Store.Alerts, a => a.State == AlertStates.Firing);
    }

    [Fact]
    public async Task Forget_drops_state_and_counts()
    {
        var h = new AlertEngineHarness();
        var s = h.Server("s1", "web-02");
        await h.TickAsync(s, AlertEngineHarness.Snapshot(diskPct: 92));
        Assert.Equal(1, h.Counts.Get("s1").Count);
        await h.Engine.ForgetAsync("s1", CancellationToken.None);
        Assert.Equal(0, h.Counts.Get("s1").Count);
        Assert.Empty(h.Engine.Firing());
    }
}
