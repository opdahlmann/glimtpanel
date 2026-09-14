using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Alerts;

namespace Glimt.Hub.Tests;

/// <summary>Alerts for container nodes (IMPLEMENTERINGSPLAN step 12.7): health_failed timing, no server_down while sleeping, server-only rules skipped, restarts from hellos.</summary>
public sealed class ContainerAlertTests
{
    [Fact]
    public async Task Health_failed_fires_after_two_minutes_not_before_and_resolves_on_first_ok()
    {
        var h = new AlertEngineHarness();
        var node = h.Node("n1", "acme-backend");

        // 0, 30, 60, 90 s: pending. At 120 s the hold is reached.
        for (var i = 0; i < 4; i++)
        {
            await h.TickAsync(node, AlertEngineHarness.NodeSnapshot(healthOk: false, status: 503, ms: 1240));
        }

        Assert.Empty(h.Sink.Events);
        await h.TickAsync(node, AlertEngineHarness.NodeSnapshot(healthOk: false, status: 503, ms: 1240));
        var fired = Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        Assert.Equal(AlertRuleIds.HealthFailed, fired.Alert.Rule);
        Assert.Equal(AlertSeverities.Warning, fired.Alert.Severity);
        Assert.Equal("GET /healthz · 503 · 1\u202f240 ms", fired.Alert.Detail);
        Assert.Equal("acme-backend", fired.ServerName);

        await h.TickAsync(node, AlertEngineHarness.NodeSnapshot(healthOk: true));
        var resolved = Assert.Single(h.Sink.OfKind(AlertEventKinds.Resolved));
        Assert.Equal(fired.Alert.Id, resolved.Alert.Id);
        Assert.Equal(0, h.Counts.Get("n1").Count);
    }

    [Fact]
    public void Health_detail_uses_the_error_when_nothing_answered()
    {
        Assert.Equal("GET /healthz · timeout · 3\u202f000 ms", RuleEvaluator.HealthDetail(new HealthInfo("https://app.example/healthz", false, null, 3000, 0, "timeout")));
        Assert.Equal("GET /healthz · 200 · 5 ms", RuleEvaluator.HealthDetail(new HealthInfo("http://127.0.0.1:8080/healthz", true, 200, 5, 0, null)));
    }

    [Fact]
    public async Task Sleeping_node_never_gets_server_down_but_a_vanished_one_does()
    {
        var h = new AlertEngineHarness();
        var node = h.Node("n1", "edge-worker");
        node.MarkSleeping(h.Clock.GetUtcNow());
        node.Detach("link-n1");

        h.Clock.Advance(TimeSpan.FromMinutes(10));
        await h.Engine.SweepAsync(CancellationToken.None);
        Assert.Empty(h.Sink.Events);
        Assert.Equal(ServerStatuses.Sleeping, node.Status);

        // Back, then gone without a bye: down after 2 min as for a server.
        node.Attach(new NullAgentLink("link-n1"), AlertEngineHarness.ContainerHello("edge-worker"), h.Clock.GetUtcNow());
        node.Detach("link-n1");
        h.Clock.Advance(TimeSpan.FromMinutes(3));
        await h.Engine.SweepAsync(CancellationToken.None);
        var fired = Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        Assert.Equal(AlertRuleIds.ServerDown, fired.Alert.Rule);
    }

    [Fact]
    public async Task Server_only_rules_are_never_evaluated_for_container_nodes()
    {
        var h = new AlertEngineHarness();
        var node = h.Node("n1", "acme-backend");
        // A snapshot that would fire svc_failed and reboot on a server.
        var snapshot = AlertEngineHarness.Snapshot(reboot: true, failedUnits: ["cron-sync.service"], diskPct: 10);
        await h.TickAsync(node, snapshot);
        Assert.Empty(h.Sink.Events);

        var server = h.Server("s1", "web-01");
        await h.TickAsync(server, snapshot);
        Assert.Equal(2, h.Sink.OfKind(AlertEventKinds.Fired).Length);
        Assert.Contains(h.Sink.Events, e => e.Alert.Rule == AlertRuleIds.SvcFailed);
        Assert.Contains(h.Sink.Events, e => e.Alert.Rule == AlertRuleIds.Reboot);
    }

    [Fact]
    public async Task Four_hellos_in_ten_minutes_fire_cont_restart_for_the_node_itself()
    {
        var h = new AlertEngineHarness();
        var node = h.Node("n1", "acme-worker");
        for (var i = 0; i < 3; i++)
        {
            h.Clock.Advance(TimeSpan.FromMinutes(2));
            node.Detach("link-n1");
            node.Attach(new NullAgentLink("link-n1"), AlertEngineHarness.ContainerHello("acme-worker"), h.Clock.GetUtcNow());
        }

        Assert.Equal(4, node.Restarts(TimeSpan.FromMinutes(10), h.Clock.GetUtcNow()));
        await h.TickAsync(node, AlertEngineHarness.NodeSnapshot());
        var fired = Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        Assert.Equal(AlertRuleIds.ContRestart, fired.Alert.Rule);
        Assert.Equal("", fired.Alert.Key);
        Assert.Equal("4 restarts / 10 min", fired.Alert.Detail);

        // Eleven minutes later only the last hello is inside the window: resolved.
        h.Clock.Advance(TimeSpan.FromMinutes(11));
        await h.TickAsync(node, AlertEngineHarness.NodeSnapshot());
        Assert.Single(h.Sink.OfKind(AlertEventKinds.Resolved));
    }

    [Fact]
    public async Task Linked_node_stopped_by_the_host_fires_cont_restart()
    {
        var h = new AlertEngineHarness();
        var host = h.Server("s1", "web-02");
        var node = h.Node("n1", "acme-backend", containerId: "abc123def456");
        var stopped = AlertEngineHarness.Snapshot(diskPct: 10, containers: [AlertEngineHarness.Container("web-api", "exited", 0, "abc123def456789")]);
        h.Linker.OnHostSnapshot(host, stopped);

        await h.TickAsync(node, AlertEngineHarness.NodeSnapshot());
        var fired = Assert.Single(h.Sink.OfKind(AlertEventKinds.Fired));
        Assert.Equal(AlertRuleIds.ContRestart, fired.Alert.Rule);
        Assert.Equal("web-api · stopped", fired.Alert.Detail);
    }

    [Fact]
    public void Health_failed_is_the_eighth_rule_and_server_only_rules_are_known()
    {
        Assert.Equal(8, AlertRules.All.Count);
        Assert.Equal(AlertRuleIds.HealthFailed, AlertRules.All[7].Id);
        Assert.Equal(120, AlertRules.HealthFailed.DurationSec);
        Assert.True(AlertRules.ServerOnly(AlertRuleIds.SvcFailed));
        Assert.True(AlertRules.ServerOnly(AlertRuleIds.Reboot));
        Assert.False(AlertRules.ServerOnly(AlertRuleIds.DiskFull));
    }
}
