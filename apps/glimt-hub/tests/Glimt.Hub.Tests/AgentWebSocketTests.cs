using System.Net.WebSockets;
using Glimt.Hub.Features.Agents;
using Microsoft.Extensions.DependencyInjection;

namespace Glimt.Hub.Tests;

public sealed class AgentWebSocketTests(HubFactory factory) : IClassFixture<HubFactory>
{
    [Fact]
    public async Task Enrol_with_dev_key_then_resume_with_token()
    {
        var ct = Repo.Timeout();
        string token;

        await using (var agent = await factory.ConnectAgentAsync(ct))
        {
            await agent.SendAsync(Repo.Hello(), ct);
            var welcome = await agent.ReceiveAsync(ct);

            Assert.NotNull(welcome);
            Assert.Equal("welcome", welcome.Value.GetProperty("type").GetString());
            Assert.Equal("dev-ubuntu-dev", welcome.Value.GetProperty("serverId").GetString());
            Assert.Equal(30_000, welcome.Value.GetProperty("snapshotInterval").GetInt32());
            Assert.Equal(600_000, welcome.Value.GetProperty("maintenanceInterval").GetInt32());
            token = welcome.Value.GetProperty("token").GetString()!;
            Assert.StartsWith("agt_", token);
            Assert.True(token.Length > 20);

            var registry = factory.Services.GetRequiredService<AgentRegistry>();
            Assert.True(registry.TryGet("dev-ubuntu-dev", out var session));
            Assert.True(session.Connected);
            Assert.Equal("up", session.Status);
            Assert.Equal("ubuntu-dev", session.Hostname);
            Assert.Equal(AgentTokens.Hash(token), session.TokenHash);
        }

        await using (var agent = await factory.ConnectAgentAsync(ct))
        {
            await agent.SendAsync(Repo.Hello(enrolKey: null, token: token), ct);
            var welcome = await agent.ReceiveAsync(ct);

            Assert.NotNull(welcome);
            Assert.Equal("welcome", welcome.Value.GetProperty("type").GetString());
            Assert.Equal("dev-ubuntu-dev", welcome.Value.GetProperty("serverId").GetString());
            Assert.False(welcome.Value.TryGetProperty("token", out _), "resume must not issue a new token");
        }
    }

    [Fact]
    public async Task Wrong_enrol_key_is_rejected()
    {
        var ct = Repo.Timeout();
        await using var agent = await factory.ConnectAgentAsync(ct);
        await agent.SendAsync(Repo.Hello(enrolKey: "gp_wrong_key"), ct);

        var failed = await agent.ReceiveAsync(ct);
        Assert.NotNull(failed);
        Assert.Equal("authFailed", failed.Value.GetProperty("type").GetString());
        Assert.Equal("invalidKey", failed.Value.GetProperty("reason").GetString());

        Assert.Null(await agent.ReceiveAsync(ct));
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, agent.Socket.CloseStatus);
    }

    [Fact]
    public async Task Unknown_token_is_rejected()
    {
        var ct = Repo.Timeout();
        await using var agent = await factory.ConnectAgentAsync(ct);
        await agent.SendAsync(Repo.Hello(enrolKey: null, token: "agt_definitely_not_a_known_token"), ct);

        var failed = await agent.ReceiveAsync(ct);
        Assert.NotNull(failed);
        Assert.Equal("authFailed", failed.Value.GetProperty("type").GetString());
        Assert.Equal("invalidToken", failed.Value.GetProperty("reason").GetString());
        Assert.Null(await agent.ReceiveAsync(ct));
    }

    [Fact]
    public async Task First_message_must_be_hello()
    {
        var ct = Repo.Timeout();
        await using var agent = await factory.ConnectAgentAsync(ct);
        await agent.SendRawAsync("""{"type":"pong"}""", ct);

        Assert.Null(await agent.ReceiveAsync(ct));
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, agent.Socket.CloseStatus);
    }

    [Fact]
    public async Task Snapshot_is_stored_on_the_session()
    {
        var ct = Repo.Timeout();
        var hello = Repo.Hello();
        hello["hostname"] = "snapshot-host";

        await using var agent = await factory.ConnectAgentAsync(ct);
        await agent.SendAsync(hello, ct);
        Assert.NotNull(await agent.ReceiveAsync(ct));

        await agent.SendAsync(Repo.Example("snapshot"), ct);
        await agent.SendRawAsync("""{"type":"whatever","x":1}""", ct);
        await agent.SendRawAsync("""{"type":"pong"}""", ct);

        var registry = factory.Services.GetRequiredService<AgentRegistry>();
        Assert.True(registry.TryGet("dev-snapshot-host", out var session));
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (session.LastSnapshot is null && DateTime.UtcNow < deadline)
        {
            await Task.Delay(25, ct);
        }

        Assert.NotNull(session.LastSnapshot);
        Assert.Equal(1757405640000, session.LastSnapshot.Ts);
        Assert.Equal(48.2, session.LastSnapshot.Host.Cpu.Total);
        Assert.NotNull(session.SnapshotAt);
        Assert.True(session.Connected, "unknown message types must not drop the connection");
    }

    [Fact]
    public async Task Messages_above_one_megabyte_close_the_socket()
    {
        var ct = Repo.Timeout();
        var hello = Repo.Hello();
        hello["hostname"] = "big-host";

        await using var agent = await factory.ConnectAgentAsync(ct);
        await agent.SendAsync(hello, ct);
        Assert.NotNull(await agent.ReceiveAsync(ct));

        var big = "{\"type\":\"pong\",\"pad\":\"" + new string('x', AgentConnection.MaxMessageBytes) + "\"}";
        await agent.SendRawAsync(big, ct);

        Assert.Null(await agent.ReceiveAsync(ct));
        Assert.Equal(WebSocketCloseStatus.MessageTooBig, agent.Socket.CloseStatus);
    }
}
