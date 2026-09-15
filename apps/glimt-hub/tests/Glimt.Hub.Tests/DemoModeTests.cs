using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Demo;
using Glimt.Hub.Features.Live;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Glimt.Hub.Tests;

/// <summary>GLIMT_ENV=e2e in the test factory implies demo mode: 16 fake servers and the /api/e2e/* controls.</summary>
public sealed class DemoModeTests(HubFactory factory) : IClassFixture<HubFactory>
{
    [Fact]
    public async Task Sixteen_cards_arrive_within_two_seconds()
    {
        var ct = Repo.Timeout(20);
        await factory.Services.GetRequiredService<FakeAgentService>().Ready.WaitAsync(TimeSpan.FromSeconds(10), ct);

        await using var connection = LiveTestSupport.Connect(factory, LiveTestSupport.Token(factory));
        var cards = new ConcurrentDictionary<string, CardDto>();
        var all = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<CardDto>("Card", c =>
        {
            if (c.Id.StartsWith(DemoData.ServerIdPrefix, StringComparison.Ordinal))
            {
                cards[c.Id] = c;
                if (cards.Count == 16)
                {
                    all.TrySetResult();
                }
            }
        });
        await connection.StartAsync(ct);
        var started = DateTime.UtcNow;
        await connection.InvokeAsync("SubscribeOverview", ct);
        await all.Task.WaitAsync(TimeSpan.FromSeconds(2), ct);
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(2));

        var api = cards["demo-api-prod"];
        Assert.True(api.Cpu >= 93, $"api-prod cpu {api.Cpu}");
        Assert.Equal(["prod"], api.Tags);
        Assert.Equal(8, api.Cores);
        Assert.Equal(9, api.ContainersTotal);
        Assert.Equal(120, api.CpuLastHour.Length);
        // The newest 30 s bucket is only filled once the snapshot tick lands in it (the browser fills the tail from the stream).
        Assert.True(api.CpuLastHour.Count(v => v is null) <= 2, "24 h of history should fill the last hour");

        var nordic = cards["demo-nordic-db"];
        Assert.Equal("down", nordic.Status);
        Assert.False(nordic.Connected);
        Assert.NotNull(nordic.LastSeenAt);
        Assert.Null(nordic.Cpu);

        Assert.Equal(1, cards["demo-worker-01"].FailedServices);
        Assert.True(cards["demo-db-prod"].RebootRequired);
        Assert.Equal("20.04", cards["demo-backup"].VersionId);
        Assert.Equal(92.0, cards["demo-web-02"].DiskWorst!.Pct);
        Assert.Equal(1, cards["demo-acme-app"].ContainersBad);
        Assert.Equal("up", cards["demo-media"].Status);

        using var client = factory.CreateClient();
        var health = await client.GetFromJsonAsync<JsonElement>("/healthz", ct);
        Assert.True(health.GetProperty("demoMode").GetBoolean());
        Assert.Equal(0, health.GetProperty("agentsConnected").GetInt32());
        Assert.True(health.GetProperty("buffer").GetProperty("points").GetInt64() > 16 * 2000);
    }

    [Fact]
    public async Task Demo_session_token_reads_demo_servers_and_their_logs()
    {
        var ct = Repo.Timeout(20);
        await factory.Services.GetRequiredService<FakeAgentService>().Ready.WaitAsync(TimeSpan.FromSeconds(10), ct);
        using var anonymous = factory.CreateClient();
        var response = await anonymous.PostAsync("/api/demo/session", null, ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        var token = body.GetProperty("accessToken").GetString()!;
        Assert.Equal(DemoData.DemoUserEmail, body.GetProperty("user").GetProperty("email").GetString());

        using var client = LiveTestSupport.Bearer(factory, token);
        var server = await client.GetFromJsonAsync<JsonElement>("/api/servers/demo-web-01/snapshot", ct);
        Assert.Equal("web-01", server.GetProperty("name").GetString());
        Assert.Equal(8, server.GetProperty("containers").GetArrayLength());
        Assert.Equal(2, server.GetProperty("host").GetProperty("mounts").GetArrayLength());

        var history = await client.GetFromJsonAsync<JsonElement>("/api/servers/demo-web-01/history?metric=mem&range=24h", ct);
        Assert.Equal(288, history.GetProperty("values").GetArrayLength());
        Assert.True(history.GetProperty("values").EnumerateArray().Count(v => v.ValueKind == JsonValueKind.Number) > 280);

        await using var connection = LiveTestSupport.Connect(factory, token);
        var lines = new TaskCompletionSource<IReadOnlyList<Features.Agents.Protocol.LogLine>>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<string, IReadOnlyList<Features.Agents.Protocol.LogLine>, int?>("Log", (_, l, _) => lines.TrySetResult(l));
        await connection.StartAsync(ct);
        var streamId = await connection.InvokeAsync<string>("StartLog", new LogRequest("demo-web-01", "auth"), ct);
        var received = await LiveTestSupport.WaitAsync(lines);
        Assert.NotEmpty(received);
        Assert.All(received, l => Assert.Contains(l.Unit, new[] { "sshd", "sudo" }));
        var open = await client.GetFromJsonAsync<JsonElement>("/api/e2e/agent-streams", ct);
        Assert.Equal(1, open.GetProperty("byServer").GetProperty("demo-web-01").GetInt32());
        await connection.InvokeAsync("StopLog", streamId, ct);
        var closed = await client.GetFromJsonAsync<JsonElement>("/api/e2e/agent-streams", ct);
        Assert.Equal(0, closed.GetProperty("total").GetInt32());

        var dev = await anonymous.PostAsJsonAsync("/api/dev/token", new { email = "nobody@glimtpanel.local" }, ct);
        Assert.Equal(HttpStatusCode.NotFound, dev.StatusCode);
    }

    [Fact]
    public async Task Demo_account_is_read_only_under_api()
    {
        // Step 10.1: every write with a demo token is 403 before it reaches an endpoint (no MongoDB needed here); reads and other users pass.
        var ct = Repo.Timeout(20);
        using var anonymous = factory.CreateClient();
        var session = await anonymous.PostAsync("/api/demo/session", null, ct);
        var token = (await session.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("accessToken").GetString()!;
        using var demo = LiveTestSupport.Bearer(factory, token);

        foreach (var write in new Func<Task<HttpResponseMessage>>[]
        {
            () => demo.PatchAsJsonAsync("/api/account", new { name = "Hacked" }, ct),
            () => demo.PostAsJsonAsync("/api/access", new { email = "someone@example.com" }, ct),
            () => demo.PutAsJsonAsync("/api/alert-settings", new { channels = new { email = true } }, ct),
            () => demo.PostAsJsonAsync("/api/servers", new { kind = "container", name = "nope" }, ct),
            () => demo.PostAsJsonAsync("/api/servers/enrol-key", new { }, ct),
            () => demo.DeleteAsync("/api/account", ct),
        })
        {
            var response = await write();
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
            Assert.Equal(DemoReadOnly.Title, problem.GetProperty("title").GetString());
        }

        Assert.NotEqual(HttpStatusCode.Forbidden, (await demo.GetAsync("/api/servers/demo-web-01/snapshot", ct)).StatusCode);
        using var dev = LiveTestSupport.Bearer(factory, LiveTestSupport.Token(factory));
        Assert.NotEqual(HttpStatusCode.Forbidden, (await dev.PatchAsJsonAsync("/api/account", new { name = "Dev" }, ct)).StatusCode);
    }

    [Fact]
    public async Task E2e_disconnect_and_advance_bring_a_server_down()
    {
        // Own hub: advance shifts this hub's clock, which would make tokens issued afterwards "not yet valid".
        var ct = Repo.Timeout(20);
        using var factory = new HubFactory();
        await factory.Services.GetRequiredService<FakeAgentService>().Ready.WaitAsync(TimeSpan.FromSeconds(10), ct);
        var token = LiveTestSupport.Token(factory);
        await using var connection = LiveTestSupport.Connect(factory, token);
        var down = new TaskCompletionSource<ServerStatusDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<ServerStatusDto>("ServerStatus", s =>
        {
            if (s.Id == "demo-cache-01" && s.Status == "down")
            {
                down.TrySetResult(s);
            }
        });
        await connection.StartAsync(ct);
        await connection.InvokeAsync("SubscribeOverview", ct);

        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/e2e/disconnect-server", new { serverId = "demo-cache-01" }, ct)).StatusCode);
        var registry = factory.Services.GetRequiredService<AgentRegistry>();
        Assert.True(registry.TryGet("demo-cache-01", out var session));
        Assert.False(session.Connected);
        Assert.Equal("up", session.Status);

        var advance = await client.PostAsJsonAsync("/api/e2e/advance", new { seconds = 130 }, ct);
        Assert.Equal(HttpStatusCode.OK, advance.StatusCode);
        Assert.Equal("down", session.Status);
        var status = await LiveTestSupport.WaitAsync(down);
        Assert.False(status.Connected);

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/e2e/fail-service", new { serverId = "demo-web-01", unit = "acme.service" }, ct)).StatusCode);
        Assert.True(registry.TryGet("demo-web-01", out var web));
        Assert.Contains("acme.service", web.LastSnapshot!.Services!.Failed!);

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/e2e/reconnect-server", new { serverId = "demo-cache-01" }, ct)).StatusCode);
        Assert.True(session.Connected);
        Assert.Equal("up", session.Status);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/e2e/explode", new { }, ct)).StatusCode);
    }
}
