using Glimt.Hub.Features.Auth;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Demo;
using Glimt.Hub.Features.Servers;
using Microsoft.Extensions.DependencyInjection;

namespace Glimt.Hub.Tests;

/// <summary>
/// Container nodes end to end against the Testcontainers hub (IMPLEMENTERINGSPLAN step 12.5): created in the
/// dashboard with a token shown once, the agent resumes with it (kind container), bye gives sleeping without an
/// alert, enrol keys are refused, rotation returns the token with 24 h overlap, slots and export count both kinds,
/// and the e2e controls drive the fake node.
/// </summary>
public sealed class ContainerNodeTests(TestHub hub) : IClassFixture<TestHub>
{
    private async Task<AgentSocket> ConnectAsync(CancellationToken ct)
    {
        var client = hub.App.Server.CreateWebSocketClient();
        return new AgentSocket(await client.ConnectAsync(new Uri("ws://localhost/agent/ws"), ct));
    }

    private static JsonObject ContainerHello(string token, string name, string containerId = "8e49456bd7f9")
    {
        var hello = Repo.Hello(enrolKey: null, token: token);
        hello["hostname"] = name;
        hello["kind"] = "container";
        hello["containerId"] = containerId;
        hello["capabilities"] = new JsonObject { ["cgroup"] = true, ["procAll"] = true, ["netns"] = true, ["health"] = true };
        hello["image"] = "nginx:1.27";
        return hello;
    }

    private async Task<(AgentSocket Agent, JsonElement Reply)> HelloAsync(JsonObject hello, CancellationToken ct)
    {
        var agent = await ConnectAsync(ct);
        await agent.SendAsync(hello, ct);
        var reply = await agent.ReceiveAsync(ct);
        Assert.NotNull(reply);
        return (agent, reply.Value);
    }

    private static async Task<JsonElement> CreateNodeAsync(TestUser owner, string name, CancellationToken ct)
    {
        var response = await owner.Client.PostAsJsonAsync("/api/servers", new { kind = "container", name }, ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>(ct);
    }

    [Fact]
    public async Task Create_node_returns_the_token_once_with_snippets_and_the_agent_resumes_with_it()
    {
        var ct = Repo.Timeout(30);
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);

        var bad = await owner.Client.PostAsJsonAsync("/api/servers", new { kind = "server", name = "x" }, ct);
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var noName = await owner.Client.PostAsJsonAsync("/api/servers", new { kind = "container", name = " " }, ct);
        Assert.Equal(HttpStatusCode.BadRequest, noName.StatusCode);

        var created = await CreateNodeAsync(owner, "api-1", ct);
        var id = created.GetProperty("id").GetString()!;
        var token = created.GetProperty("token").GetString()!;
        Assert.StartsWith("agt_", token);
        Assert.Equal("container", created.GetProperty("kind").GetString());
        Assert.Equal("api-1", created.GetProperty("name").GetString());
        Assert.Equal("ws://localhost:5080/agent/ws", created.GetProperty("hubUrl").GetString());
        Assert.Equal(ContainerSnippets.DefaultImage, created.GetProperty("agentImage").GetString());
        var compose = created.GetProperty("compose").GetString()!;
        Assert.Contains("pid: \"service:app\"", compose);
        Assert.Contains("GLIMT_TOKEN: " + token, compose);
        Assert.Contains("GLIMT_NODE_NAME: api-1", compose);
        Assert.Contains("COPY --from=" + ContainerSnippets.DefaultImage, created.GetProperty("dockerfile").GetString());

        // Only the hash is stored; the node is down without a last-seen until the first hello.
        var doc = await hub.Services.GetRequiredService<IServerStore>().FindAsync(id, ct);
        Assert.NotNull(doc);
        Assert.Equal(Tokens.Hash(token), doc.TokenHash);
        Assert.Equal("container", doc.Kind);
        Assert.Equal("down", doc.Status);
        Assert.Null(doc.LastSeenAt);
        Assert.Equal(owner.Id, doc.OwnerId);

        var list = await owner.Client.GetFromJsonAsync<JsonElement>("/api/servers", ct);
        var item = list.EnumerateArray().Single(s => s.GetProperty("id").GetString() == id);
        Assert.Equal("container", item.GetProperty("kind").GetString());
        Assert.Equal("down", item.GetProperty("status").GetString());

        // The sidecar connects with the token: no enrolment, kind container, hostname/containerId/capabilities/image on the node.
        var (agent, welcome) = await HelloAsync(ContainerHello(token, "8e49456bd7f9"), ct);
        await using var agentScope = agent;
        Assert.Equal("welcome", welcome.GetProperty("type").GetString());
        Assert.Equal(id, welcome.GetProperty("serverId").GetString());
        Assert.False(welcome.TryGetProperty("token", out _), "a node token is never re-issued");

        var registry = hub.Services.GetRequiredService<AgentRegistry>();
        Assert.True(registry.TryGet(id, out var session));
        Assert.True(session.IsContainer);
        Assert.Equal("up", session.Status);
        Assert.Equal("8e49456bd7f9", session.ContainerId);
        Assert.Equal("nginx:1.27", session.Image);
        Assert.True(session.Capabilities!.Health);
        Assert.Equal("api-1", session.Name);

        var card = Projections.Card(session, null, DateTimeOffset.UtcNow);
        Assert.Equal("container", card.Kind);
        Assert.Equal(1, card.Restarts24h);
        Assert.Equal(HealthStates.None, card.Health);

        await agent.SendAsync(Repo.Example("snapshot-container"), ct);
        await Task.Delay(200, ct);
        Assert.NotNull(session.LastSnapshot?.Health);
        var server = Projections.Server(session);
        Assert.Equal("container", server.Kind);
        Assert.True(server.Health!.Ok);
        Assert.Equal(2, server.Checks!.Count);
        Assert.Null(server.Services);

        var detail = await owner.Client.GetFromJsonAsync<JsonElement>($"/api/servers/{id}", ct);
        Assert.Equal("nginx:1.27", detail.GetProperty("image").GetString());
        Assert.Equal("8e49456bd7f9", detail.GetProperty("hostname").GetString());
    }

    [Fact]
    public async Task Enrol_key_is_refused_for_container_nodes()
    {
        var ct = Repo.Timeout(20);
        var hello = Repo.Hello(enrolKey: HubFactory.EnrolKey);
        hello["kind"] = "container";
        var (agent, failed) = await HelloAsync(hello, ct);
        await using var scope = agent;
        Assert.Equal("authFailed", failed.GetProperty("type").GetString());
        Assert.Equal("containerNeedsToken", failed.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Bye_gives_sleeping_without_server_down_and_the_next_hello_gives_up()
    {
        var ct = Repo.Timeout(30);
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        var created = await CreateNodeAsync(owner, "worker-1", ct);
        var id = created.GetProperty("id").GetString()!;
        var token = created.GetProperty("token").GetString()!;
        var registry = hub.Services.GetRequiredService<AgentRegistry>();

        var (agent, _) = await HelloAsync(ContainerHello(token, "worker-1"), ct);
        await agent.SendAsync(new JsonObject { ["type"] = "bye", ["reason"] = "shutdown" }, ct);
        await agent.CloseAsync(ct);
        Assert.True(registry.TryGet(id, out var session));
        await WaitUntilAsync(() => !session.Connected, ct);
        Assert.Equal(ServerStatuses.Sleeping, session.Status);

        // Sweeps leave a sleeping node alone: no down, no server_down.
        await hub.Services.GetRequiredService<DownDetector>().SweepAsync(persist: false, ct);
        var alerts = hub.Services.GetRequiredService<AlertEngine>();
        await alerts.SweepAsync(ct);
        Assert.Equal(ServerStatuses.Sleeping, session.Status);
        Assert.Empty(alerts.Firing(id));

        var listed = (await owner.Client.GetFromJsonAsync<JsonElement>("/api/servers", ct)).EnumerateArray().Single(s => s.GetProperty("id").GetString() == id);
        Assert.Equal("sleeping", listed.GetProperty("status").GetString());
        Assert.NotNull(listed.GetProperty("lastSeenAt").GetString());
        var stored = await hub.Services.GetRequiredService<IServerStore>().FindAsync(id, ct);
        Assert.Equal("sleeping", stored!.Status);

        // Back: up again; three hellos so far → restarts10m 3.
        var (again, welcome) = await HelloAsync(ContainerHello(token, "worker-1"), ct);
        Assert.Equal("welcome", welcome.GetProperty("type").GetString());
        Assert.Equal("up", session.Status);
        var (third, _) = await HelloAsync(ContainerHello(token, "worker-1"), ct);
        await using var thirdScope = third;
        Assert.Equal(3, session.Restarts(TimeSpan.FromMinutes(10), DateTimeOffset.UtcNow));
        Assert.Equal(3, Projections.Server(session).Restarts10m);
        await again.DisposeAsync();
    }

    [Fact]
    public async Task Rotate_returns_the_new_token_and_the_old_one_works_for_a_day()
    {
        var ct = Repo.Timeout(30);
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        var created = await CreateNodeAsync(owner, "rot-node", ct);
        var id = created.GetProperty("id").GetString()!;
        var oldToken = created.GetProperty("token").GetString()!;

        var response = await owner.Client.PostAsync($"/api/servers/{id}/rotate-key", null, ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        var newToken = body.GetProperty("token").GetString()!;
        Assert.StartsWith("agt_", newToken);
        Assert.NotEqual(oldToken, newToken);
        var until = body.GetProperty("oldTokenValidUntil").GetDateTimeOffset();
        Assert.InRange(until, DateTimeOffset.UtcNow.AddHours(23.9), DateTimeOffset.UtcNow.AddHours(24.1));

        var doc = await hub.Services.GetRequiredService<IServerStore>().FindAsync(id, ct);
        Assert.Equal(Tokens.Hash(newToken), doc!.TokenHash);
        Assert.Equal(Tokens.Hash(oldToken), doc.PreviousTokenHash);
        // The test hub records lifecycle calls instead of running AgentLifecycle: do what it would do with the registry.
        Assert.Contains(hub.Lifecycle.Rotated, r => r.ServerId == id && r.Token == newToken);
        var registry = hub.Services.GetRequiredService<AgentRegistry>();
        Assert.True(registry.TryGet(id, out var session));
        session.RotateToken(Tokens.Hash(newToken), DateTimeOffset.UtcNow, AgentLifecycle.ContainerTokenOverlap);
        Assert.Equal(TimeSpan.FromHours(24), AgentLifecycle.ContainerTokenOverlap);

        // Both resume (the registry holds the 24 h grace).
        var (withOld, welcomeOld) = await HelloAsync(ContainerHello(oldToken, "rot-node"), ct);
        Assert.Equal("welcome", welcomeOld.GetProperty("type").GetString());
        var (withNew, welcomeNew) = await HelloAsync(ContainerHello(newToken, "rot-node"), ct);
        await using var newScope = withNew;
        Assert.Equal("welcome", welcomeNew.GetProperty("type").GetString());
        await withOld.DisposeAsync();

        // A server's rotate still answers 204 and never returns the token.
        var server = await hub.AddServerAsync(owner.Id, "rot-server");
        var serverRotate = await owner.Client.PostAsync($"/api/servers/{server.Id}/rotate-key", null, ct);
        Assert.Equal(HttpStatusCode.NoContent, serverRotate.StatusCode);
    }

    [Fact]
    public async Task Slots_count_both_kinds_export_has_kind_and_delete_gives_a_hint_instead_of_a_command()
    {
        var ct = Repo.Timeout(30);
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        await hub.AddServerAsync(owner.Id, "srv-1");
        var created = await CreateNodeAsync(owner, "node-1", ct);
        var id = created.GetProperty("id").GetString()!;

        var subscription = await owner.Client.GetFromJsonAsync<JsonElement>("/api/subscription", ct);
        Assert.Equal(2, subscription.GetProperty("slotsUsed").GetInt32());

        var export = await owner.Client.GetFromJsonAsync<JsonElement>("/api/account/export", ct);
        var kinds = export.GetProperty("servers").EnumerateArray().ToDictionary(s => s.GetProperty("name").GetString()!, s => s.GetProperty("kind").GetString());
        Assert.Equal("server", kinds["srv-1"]);
        Assert.Equal("container", kinds["node-1"]);

        var deleted = await owner.Client.DeleteAsync($"/api/servers/{id}", ct);
        Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        var body = await deleted.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("uninstallCommand").ValueKind);
        Assert.Equal("container", body.GetProperty("kind").GetString());
        Assert.Equal(ServersEndpoints.RemoveSidecarHint, body.GetProperty("hint").GetString());
        Assert.Contains(id, hub.Lifecycle.Removed);
    }

    [Fact]
    public async Task E2e_controls_connect_a_fake_node_put_it_to_sleep_and_fail_its_health()
    {
        var ct = Repo.Timeout(40);
        var demo = hub.Services.GetRequiredService<FakeAgentService>();
        await demo.Ready.WaitAsync(TimeSpan.FromSeconds(20), ct);
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        var created = await CreateNodeAsync(owner, "e2e-node", ct);
        var id = created.GetProperty("id").GetString()!;
        var token = created.GetProperty("token").GetString()!;
        using var anonymous = hub.CreateClient();

        var bogus = await anonymous.PostAsJsonAsync("/api/e2e/connect-fake-container", new { token = "agt_nope" }, ct);
        Assert.Equal(HttpStatusCode.NotFound, bogus.StatusCode);
        var connected = await anonymous.PostAsJsonAsync("/api/e2e/connect-fake-container", new { token }, ct);
        Assert.Equal(HttpStatusCode.OK, connected.StatusCode);
        Assert.Equal(id, (await connected.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("serverId").GetString());

        var registry = hub.Services.GetRequiredService<AgentRegistry>();
        Assert.True(registry.TryGet(id, out var session));
        Assert.True(session.Connected);
        Assert.True(session.IsContainer);
        Assert.True(session.LastSnapshot!.Health!.Ok);

        var failed = await anonymous.PostAsJsonAsync("/api/e2e/fail-health", new { serverId = id }, ct);
        Assert.Equal(HttpStatusCode.OK, failed.StatusCode);
        Assert.False(session.LastSnapshot!.Health!.Ok);
        Assert.Equal(HealthStates.Fail, Projections.Card(session, null, DateTimeOffset.UtcNow).Health);

        var slept = await anonymous.PostAsJsonAsync("/api/e2e/sleep-node", new { serverId = id }, ct);
        Assert.Equal(HttpStatusCode.OK, slept.StatusCode);
        Assert.False(session.Connected);
        Assert.Equal(ServerStatuses.Sleeping, session.Status);

        // The three demo nodes exist alongside the 16 servers.
        Assert.Equal(3, demo.Nodes.Count(n => DemoData.Nodes.Any(d => d.Name == n.Name)));
        Assert.True(registry.TryGet(DemoData.ServerIdPrefix + "acme-backend", out var backend));
        Assert.True(backend.IsContainer);
        Assert.Equal("ghcr.io/acme/backend:2.4.1", backend.Image);
    }

    private static async Task WaitUntilAsync(Func<bool> condition, CancellationToken ct)
    {
        while (!condition())
        {
            await Task.Delay(25, ct);
        }
    }
}
