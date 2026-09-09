using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Infrastructure.Servers;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;

namespace Glimt.Hub.Tests;

/// <summary>Token rotation, server removal and the snapshot endpoint, with a FakeTimeProvider as the hub clock.</summary>
public sealed class AgentsLifecycleTests : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.UtcNow);
    private HubFactory _root = null!;
    private WebApplicationFactory<Program> _app = null!;

    public Task InitializeAsync()
    {
        _root = new HubFactory();
        _app = _root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services => services.AddSingleton<TimeProvider>(_clock)));
        return Task.CompletedTask;
    }

    public Task DisposeAsync()
    {
        _app.Dispose();
        _root.Dispose();
        return Task.CompletedTask;
    }

    private async Task<AgentSocket> ConnectAsync(CancellationToken ct)
    {
        var client = _app.Server.CreateWebSocketClient();
        return new AgentSocket(await client.ConnectAsync(new Uri("ws://localhost/agent/ws"), ct));
    }

    private async Task<(AgentSocket Agent, JsonElement Welcome)> HelloAsync(string hostname, string? enrolKey, string? token, CancellationToken ct)
    {
        var hello = Repo.Hello(enrolKey, token);
        hello["hostname"] = hostname;
        var agent = await ConnectAsync(ct);
        await agent.SendAsync(hello, ct);
        var reply = await agent.ReceiveAsync(ct);
        Assert.NotNull(reply);
        return (agent, reply.Value);
    }

    /// <summary>The hub closed the socket (replaced or removed): answer the close frame so the handshake completes, then dispose.</summary>
    private static async Task AcknowledgeCloseAsync(AgentSocket agent, CancellationToken ct)
    {
        while (await agent.ReceiveAsync(ct) is not null)
        {
        }

        await agent.CloseAsync(ct);
        agent.Socket.Dispose();
    }

    [Fact]
    public async Task Rotate_reaches_the_agent_and_the_old_token_works_for_ten_minutes()
    {
        var ct = Repo.Timeout(20);
        var (agent, welcome) = await HelloAsync("rot-host", HubFactory.EnrolKey, null, ct);
        var oldToken = welcome.GetProperty("token").GetString()!;

        var newToken = AgentTokens.Generate();
        var lifecycle = _app.Services.GetRequiredService<IServerLifecycle>();
        Assert.IsType<AgentLifecycle>(lifecycle);
        await lifecycle.TokenRotatedAsync("dev-rot-host", newToken, AgentTokens.Hash(newToken), ct);

        var rotate = await LiveTestSupport.ExpectAsync(agent, "rotate", ct);
        Assert.NotNull(rotate);
        Assert.Equal(newToken, rotate.Value.GetProperty("token").GetString());

        // New token resumes (and replaces the first connection, which the hub closes).
        var (withNew, welcomeNew) = await HelloAsync("rot-host", null, newToken, ct);
        Assert.Equal("welcome", welcomeNew.GetProperty("type").GetString());
        Assert.Equal("dev-rot-host", welcomeNew.GetProperty("serverId").GetString());
        await AcknowledgeCloseAsync(agent, ct);

        // Old token still resumes inside the grace period …
        _clock.Advance(TimeSpan.FromMinutes(9));
        var (withOld, welcomeOld) = await HelloAsync("rot-host", null, oldToken, ct);
        Assert.Equal("welcome", welcomeOld.GetProperty("type").GetString());
        await AcknowledgeCloseAsync(withNew, ct);

        // … and not after it.
        _clock.Advance(TimeSpan.FromMinutes(2));
        var (tooLate, failed) = await HelloAsync("rot-host", null, oldToken, ct);
        await using var lateScope = tooLate;
        Assert.Equal("authFailed", failed.GetProperty("type").GetString());
        Assert.Equal("invalidToken", failed.GetProperty("reason").GetString());
        await withOld.DisposeAsync();
    }

    [Fact]
    public async Task Removed_server_gets_authFailed_serverRemoved_and_leaves_the_registry()
    {
        var ct = Repo.Timeout(20);
        var (agent, _) = await HelloAsync("rm-host", HubFactory.EnrolKey, null, ct);
        var registry = _app.Services.GetRequiredService<AgentRegistry>();
        Assert.True(registry.TryGet("dev-rm-host", out _));

        await _app.Services.GetRequiredService<IServerLifecycle>().ServerRemovedAsync("dev-rm-host", ct);

        var failed = await LiveTestSupport.ExpectAsync(agent, "authFailed", ct);
        Assert.NotNull(failed);
        Assert.Equal("serverRemoved", failed.Value.GetProperty("reason").GetString());
        Assert.Null(await agent.ReceiveAsync(ct));
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, agent.Socket.CloseStatus);
        Assert.False(registry.TryGet("dev-rm-host", out _));
        await agent.CloseAsync(ct);
        agent.Socket.Dispose();
    }

    [Fact]
    public async Task Snapshot_endpoint_returns_404_204_then_the_merged_projection()
    {
        var ct = Repo.Timeout(20);
        var token = LiveTestSupport.Token(_app);
        using var client = LiveTestSupport.Bearer(_app, token);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/servers/dev-nobody/snapshot", ct)).StatusCode);

        var (agent, _) = await HelloAsync("snap-host", HubFactory.EnrolKey, null, ct);
        await using var agentScope = agent;
        Assert.Equal(HttpStatusCode.NoContent, (await client.GetAsync("/api/servers/dev-snap-host/snapshot", ct)).StatusCode);

        await agent.SendAsync(Repo.Example("snapshot"), ct);
        await agent.SendAsync(LiveTestSupport.Stream(12.5), ct);
        await agent.SendRawAsync("""{"type":"pong"}""", ct);
        var registry = _app.Services.GetRequiredService<AgentRegistry>();
        Assert.True(registry.TryGet("dev-snap-host", out var session));
        while (session.LastStream is null)
        {
            await Task.Delay(20, ct);
        }

        var response = await client.GetAsync("/api/servers/dev-snap-host/snapshot", ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("dev-snap-host", body.GetProperty("id").GetString());
        Assert.Equal(12.5, body.GetProperty("host").GetProperty("cpu").GetProperty("total").GetDouble());
        Assert.Equal("/", body.GetProperty("host").GetProperty("mounts")[0].GetProperty("path").GetString());
        Assert.Equal(2, body.GetProperty("processes").GetArrayLength());
        Assert.Equal(7.5, body.GetProperty("containers")[0].GetProperty("cpuPct").GetDouble());
        Assert.Equal("web-web", body.GetProperty("containers")[0].GetProperty("name").GetString());
        Assert.True(body.GetProperty("maintenance").GetProperty("rebootRequired").GetBoolean());
        Assert.NotNull(body.GetProperty("snapshotAt").GetString());

        using var anonymous = _app.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/servers/dev-snap-host/snapshot", ct)).StatusCode);
    }

    [Fact]
    public async Task Disconnected_agent_goes_down_after_the_configured_time()
    {
        var ct = Repo.Timeout(20);
        var (agent, _) = await HelloAsync("down-host", HubFactory.EnrolKey, null, ct);
        await agent.DisposeAsync();
        var registry = _app.Services.GetRequiredService<AgentRegistry>();
        Assert.True(registry.TryGet("dev-down-host", out var session));
        while (session.Connected)
        {
            await Task.Delay(20, ct);
        }

        var detector = _app.Services.GetRequiredService<DownDetector>();
        _clock.Advance(TimeSpan.FromSeconds(60));
        await detector.SweepAsync(false, ct);
        Assert.Equal("up", session.Status);

        _clock.Advance(TimeSpan.FromSeconds(61));
        await detector.SweepAsync(false, ct);
        Assert.Equal("down", session.Status);
    }
}
