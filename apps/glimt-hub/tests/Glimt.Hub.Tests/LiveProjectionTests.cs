using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Infrastructure.Access;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Glimt.Hub.Tests;

/// <summary>Card/Server projections, subscription counting, interval and the log relay through a fake agent socket.</summary>
public sealed class LiveProjectionTests(HubFactory factory) : IClassFixture<HubFactory>
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Snapshot_and_stream_become_card_and_server(bool messagePack)
    {
        var ct = Repo.Timeout(20);
        var host = "proj-" + (messagePack ? "msgpack" : "json");
        var (agent, _, serverId) = await LiveTestSupport.ConnectAgentAsync(factory, host, ct);
        await using var agentScope = agent;

        await using var connection = LiveTestSupport.Connect(factory, LiveTestSupport.Token(factory), messagePack);
        var card = new TaskCompletionSource<CardDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new TaskCompletionSource<ServerDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<CardDto>("Card", c =>
        {
            if (c.Id == serverId && c.Cpu is not null)
            {
                card.TrySetResult(c);
            }
        });
        connection.On<ServerDto>("Server", s =>
        {
            if (s.Id == serverId && s.Processes is { Count: > 0 })
            {
                server.TrySetResult(s);
            }
        });
        await connection.StartAsync(ct);
        await connection.InvokeAsync("SubscribeOverview", ct);
        await connection.InvokeAsync("SubscribeServer", serverId, ct);
        Assert.NotNull(await LiveTestSupport.ExpectAsync(agent, "subscribe", ct));

        await agent.SendAsync(Repo.Example("snapshot"), ct);
        var c = await LiveTestSupport.WaitAsync(card);
        Assert.Equal(48.2, c.Cpu);
        Assert.Equal(61.0, c.Mem);
        Assert.Equal("/", c.DiskWorst!.Path);
        Assert.Equal(92.0, c.DiskWorst.Pct);
        Assert.Equal(15518924, c.NetRx);
        Assert.Equal(1, c.ContainersRunning);
        Assert.Equal(1, c.ContainersTotal);
        Assert.Equal(0, c.ContainersBad);
        Assert.Equal(12, c.Updates);
        Assert.Equal(4, c.SecurityUpdates);
        Assert.True(c.RebootRequired);
        Assert.Equal(1, c.FailedServices);
        Assert.Equal("Ubuntu 24.04.2 LTS", c.Os);
        Assert.Equal("24.04", c.VersionId);
        Assert.Equal(120, c.CpuLastHour.Length);
        Assert.Equal(48, c.CpuLastHour[^1]);
        Assert.Equal(61, c.MemLastHour[^1]);
        Assert.Null(c.CpuLastHour[0]);

        await agent.SendAsync(LiveTestSupport.Stream(33.3), ct);
        var s = await LiveTestSupport.WaitAsync(server);
        Assert.Equal(33.3, s.Host!.Cpu.Total);
        Assert.Equal(2, s.Processes!.Count);
        Assert.Equal(181, s.ProcessTotals!.Total);
        Assert.Equal("web-web", Assert.Single(s.Containers!).Name);
        Assert.Equal(7.5, s.Containers![0].CpuPct);
        Assert.Equal(["cron-sync.service"], s.Services!.Failed);
        Assert.Equal(42, s.Security!.Firewall!.Banned);
        Assert.NotNull(s.StreamAt);
    }

    [Fact]
    public async Task Two_subscribers_give_one_subscribe_and_the_last_one_leaving_unsubscribes()
    {
        var ct = Repo.Timeout(20);
        var (agent, _, serverId) = await LiveTestSupport.ConnectAgentAsync(factory, "subs-host", ct);
        await using var agentScope = agent;
        var counter = factory.Services.GetRequiredService<SubscriptionCounter>();

        await using var first = LiveTestSupport.Connect(factory, LiveTestSupport.Token(factory));
        await using var second = LiveTestSupport.Connect(factory, LiveTestSupport.Token(factory, "u-two"));
        await first.StartAsync(ct);
        await second.StartAsync(ct);

        await first.InvokeAsync("SubscribeServer", serverId, ct);
        var subscribe = await LiveTestSupport.ExpectAsync(agent, "subscribe", ct);
        Assert.NotNull(subscribe);
        Assert.Equal(1000, subscribe.Value.GetProperty("intervalMs").GetInt32());
        Assert.Equal(40, subscribe.Value.GetProperty("topProcs").GetInt32());

        await second.InvokeAsync("SubscribeServer", serverId, ct);
        Assert.Equal(2, counter.SubscriberCount(serverId));
        await LiveTestSupport.AssertQuietAsync(agent, TimeSpan.FromMilliseconds(400));

        // 5000 from one of two does not change the minimum …
        await second.InvokeAsync("SetInterval", 5000, ct);
        await LiveTestSupport.AssertQuietAsync(agent, TimeSpan.FromMilliseconds(300));

        // … but once the 1000 subscriber leaves, the only subscriber's 5000 is sent.
        await first.InvokeAsync("UnsubscribeServer", serverId, ct);
        var slower = await LiveTestSupport.ExpectAsync(agent, "subscribe", ct);
        Assert.Equal(5000, slower!.Value.GetProperty("intervalMs").GetInt32());
        Assert.Equal(1, counter.SubscriberCount(serverId));

        await second.StopAsync(ct);
        Assert.NotNull(await LiveTestSupport.ExpectAsync(agent, "unsubscribe", ct));
        Assert.Equal(0, counter.SubscriberCount(serverId));

        await Assert.ThrowsAsync<HubException>(() => first.InvokeAsync("SetInterval", 2000, ct));
    }

    [Fact]
    public async Task Reconnecting_agent_is_subscribed_again_while_someone_watches()
    {
        var ct = Repo.Timeout(20);
        var (agent, token, serverId) = await LiveTestSupport.ConnectAgentAsync(factory, "resub-host", ct);
        await using var connection = LiveTestSupport.Connect(factory, LiveTestSupport.Token(factory));
        await connection.StartAsync(ct);
        await connection.InvokeAsync("SubscribeServer", serverId, ct);
        Assert.NotNull(await LiveTestSupport.ExpectAsync(agent, "subscribe", ct));
        await agent.DisposeAsync();

        var hello = Repo.Hello(enrolKey: null, token: token);
        hello["hostname"] = "resub-host";
        await using var again = await factory.ConnectAgentAsync(ct);
        await again.SendAsync(hello, ct);
        Assert.Equal("welcome", (await again.ReceiveAsync(ct))!.Value.GetProperty("type").GetString());
        var subscribe = await LiveTestSupport.ExpectAsync(again, "subscribe", ct);
        Assert.Equal(1000, subscribe!.Value.GetProperty("intervalMs").GetInt32());
    }

    [Fact]
    public async Task Log_stream_is_relayed_both_ways_and_stopped_on_disconnect()
    {
        var ct = Repo.Timeout(20);
        var (agent, _, serverId) = await LiveTestSupport.ConnectAgentAsync(factory, "log-host", ct);
        await using var agentScope = agent;

        await using var connection = LiveTestSupport.Connect(factory, LiveTestSupport.Token(factory));
        var lines = new TaskCompletionSource<(string StreamId, IReadOnlyList<LogLine> Lines, int? Dropped)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var ended = new TaskCompletionSource<(string StreamId, string Reason, string? Message)>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<string, IReadOnlyList<LogLine>, int?>("Log", (id, l, d) => lines.TrySetResult((id, l, d)));
        connection.On<string, string, string?>("LogEnded", (id, r, m) => ended.TrySetResult((id, r, m)));
        await connection.StartAsync(ct);

        var streamId = await connection.InvokeAsync<string>("StartLog", new LogRequest(serverId, "journal", Unit: "nginx.service", Tail: 50), ct);
        var start = await LiveTestSupport.ExpectAsync(agent, "logStart", ct);
        Assert.Equal(streamId, start!.Value.GetProperty("streamId").GetString());
        Assert.Equal("journal", start.Value.GetProperty("source").GetString());
        Assert.Equal("nginx.service", start.Value.GetProperty("unit").GetString());
        Assert.Equal(50, start.Value.GetProperty("tail").GetInt32());

        await agent.SendRawAsync($$"""{"type":"log","streamId":"{{streamId}}","dropped":2,"lines":[{"ts":1757405640000,"unit":"nginx.service","priority":"info","message":"hello"}]}""", ct);
        var received = await LiveTestSupport.WaitAsync(lines);
        Assert.Equal(streamId, received.StreamId);
        Assert.Equal("hello", Assert.Single(received.Lines).Message);
        Assert.Equal(2, received.Dropped);

        await agent.SendRawAsync($$"""{"type":"logEnd","streamId":"{{streamId}}","reason":"eof"}""", ct);
        var end = await LiveTestSupport.WaitAsync(ended);
        Assert.Equal((streamId, "eof", (string?)null), end);
        Assert.Equal(0, factory.Services.GetRequiredService<LogRelay>().Count);

        // Stop from the browser forwards logStop; a disconnect stops the rest.
        var second = await connection.InvokeAsync<string>("StartLog", new LogRequest(serverId, "auth"), ct);
        Assert.NotNull(await LiveTestSupport.ExpectAsync(agent, "logStart", ct));
        await connection.InvokeAsync("StopLog", second, ct);
        Assert.Equal(second, (await LiveTestSupport.ExpectAsync(agent, "logStop", ct))!.Value.GetProperty("streamId").GetString());

        var third = await connection.InvokeAsync<string>("StartLog", new LogRequest(serverId, "kernel"), ct);
        Assert.NotNull(await LiveTestSupport.ExpectAsync(agent, "logStart", ct));
        await connection.StopAsync(ct);
        Assert.Equal(third, (await LiveTestSupport.ExpectAsync(agent, "logStop", ct))!.Value.GetProperty("streamId").GetString());
    }

    [Fact]
    public async Task More_than_four_streams_per_connection_end_with_an_error()
    {
        var ct = Repo.Timeout(20);
        var (agent, _, serverId) = await LiveTestSupport.ConnectAgentAsync(factory, "limit-host", ct);
        await using var agentScope = agent;
        await using var connection = LiveTestSupport.Connect(factory, LiveTestSupport.Token(factory));
        var ended = new TaskCompletionSource<(string Reason, string? Message)>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<string, string, string?>("LogEnded", (_, r, m) => ended.TrySetResult((r, m)));
        await connection.StartAsync(ct);

        for (var i = 0; i < LogRelay.MaxPerConnection; i++)
        {
            await connection.InvokeAsync<string>("StartLog", new LogRequest(serverId, "journal"), ct);
            Assert.NotNull(await LiveTestSupport.ExpectAsync(agent, "logStart", ct));
        }

        await connection.InvokeAsync<string>("StartLog", new LogRequest(serverId, "journal"), ct);
        Assert.Equal(("error", "too many streams"), await LiveTestSupport.WaitAsync(ended));
    }

    [Fact]
    public async Task Foreign_server_is_forbidden()
    {
        var ct = Repo.Timeout(20);
        using var app = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services => services.AddSingleton<IAccessService, DenyForeignAccessService>()));
        await using var connection = LiveTestSupport.Connect(app, LiveTestSupport.Token(app));
        await connection.StartAsync(ct);

        var ex = await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync("SubscribeServer", "foreign-server", ct));
        Assert.Contains("forbidden", ex.Message);
        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync<string>("StartLog", new LogRequest("foreign-server", "journal"), ct));

        using var client = LiveTestSupport.Bearer(app, LiveTestSupport.Token(app));
        var registry = app.Services.GetRequiredService<AgentRegistry>();
        registry.GetOrAdd("foreign-known");
        Assert.Equal(System.Net.HttpStatusCode.Forbidden, (await client.GetAsync("/api/servers/foreign-known/snapshot", ct)).StatusCode);
        Assert.Equal(System.Net.HttpStatusCode.Forbidden, (await client.GetAsync("/api/servers/foreign-known/history?metric=cpu&range=1h", ct)).StatusCode);
    }

    private sealed class DenyForeignAccessService : IAccessService
    {
        public Task<IReadOnlyList<string>> VisibleServerIdsAsync(string userId, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<string>>([]);

        public Task<bool> CanReadAsync(string userId, string serverId, CancellationToken cancellationToken) => Task.FromResult(!serverId.StartsWith("foreign", StringComparison.Ordinal));

        public Task<bool> IsOwnerAsync(string userId, string serverId, CancellationToken cancellationToken) => CanReadAsync(userId, serverId, cancellationToken);

        public Task<IReadOnlyList<string>> UserIdsWithAccessAsync(string serverId, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<string>>([]);
    }
}
