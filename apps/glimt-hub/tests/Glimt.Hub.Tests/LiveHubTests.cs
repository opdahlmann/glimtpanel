using Glimt.Hub.Features.Live;
using Microsoft.AspNetCore.SignalR.Client;

namespace Glimt.Hub.Tests;

public sealed class LiveHubTests(HubFactory factory) : IClassFixture<HubFactory>
{
    [Fact]
    public async Task Overview_subscriber_receives_server_status_when_an_agent_connects()
    {
        var ct = Repo.Timeout(15);
        var hello = Repo.Hello();
        hello["hostname"] = "live-host";

        await using var connection = LiveTestSupport.Connect(factory, LiveTestSupport.Token(factory));
        var up = new TaskCompletionSource<ServerStatusDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<ServerStatusDto>("ServerStatus", dto =>
        {
            if (dto.Id == "dev-live-host" && dto.Status == "up")
            {
                up.TrySetResult(dto);
            }
        });

        await connection.StartAsync(ct);
        await connection.InvokeAsync("SubscribeOverview", ct);

        await using var agent = await factory.ConnectAgentAsync(ct);
        await agent.SendAsync(hello, ct);
        Assert.NotNull(await agent.ReceiveAsync(ct));

        var status = await up.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
        Assert.Equal("live-host", status.Hostname);
        Assert.Equal("live-host", status.Name);
        Assert.True(status.Connected);
        Assert.Equal("Ubuntu 24.04.2 LTS", status.Os);
        Assert.Equal("arm64", status.Arch);
        Assert.Equal(4, status.Cores);
        Assert.Equal(8589934592, status.RamBytes);
        Assert.Equal("0.1.0", status.AgentVersion);
        Assert.NotNull(status.LastSeenAt);
        Assert.EndsWith("Z", status.LastSeenAt);
    }

    [Fact]
    public async Task Late_subscriber_gets_known_servers_immediately()
    {
        var ct = Repo.Timeout(15);
        var hello = Repo.Hello();
        hello["hostname"] = "late-host";

        await using var agent = await factory.ConnectAgentAsync(ct);
        await agent.SendAsync(hello, ct);
        Assert.NotNull(await agent.ReceiveAsync(ct));

        await using var connection = LiveTestSupport.Connect(factory, LiveTestSupport.Token(factory));
        var seen = new TaskCompletionSource<ServerStatusDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<ServerStatusDto>("ServerStatus", dto =>
        {
            if (dto.Id == "dev-late-host")
            {
                seen.TrySetResult(dto);
            }
        });

        await connection.StartAsync(ct);
        await connection.InvokeAsync("SubscribeOverview", ct);

        var status = await seen.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
        Assert.Equal("up", status.Status);

        await connection.InvokeAsync("UnsubscribeOverview", ct);
    }

    [Fact]
    public async Task Anonymous_connection_is_rejected()
    {
        var ct = Repo.Timeout(15);
        await using var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, "hub/live"), options =>
            {
                options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                options.Transports = Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling;
            })
            .Build();

        var ex = await Assert.ThrowsAnyAsync<Exception>(() => connection.StartAsync(ct));
        Assert.Contains("401", ex.Message);
    }
}
