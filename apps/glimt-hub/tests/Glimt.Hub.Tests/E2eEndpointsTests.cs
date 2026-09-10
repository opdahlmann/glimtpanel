using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Demo;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Glimt.Hub.Tests;

/// <summary>
/// The two e2e controls phase 4 adds (IMPLEMENTERINGSPLAN steps 4.3–4.5): a fake agent that consumes a real
/// one-time key so the "Add server" flow can be driven end to end, and test accounts (owner without servers,
/// reader of the demo servers). Both need MongoDB, so they run against the Testcontainers hub.
/// </summary>
public sealed class E2eEndpointsTests(TestHub hub) : IClassFixture<TestHub>
{
    [Fact]
    public async Task Enrol_fake_agent_consumes_the_key_and_publishes_ServerAdded_to_the_owner()
    {
        var ct = Repo.Timeout(30);
        await hub.Services.GetRequiredService<FakeAgentService>().Ready.WaitAsync(TimeSpan.FromSeconds(20), ct);
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);

        var keyResponse = await owner.Client.PostAsJsonAsync("/api/servers/enrol-key", new { dockerMode = "proxy" }, ct);
        Assert.Equal(HttpStatusCode.OK, keyResponse.StatusCode);
        var key = (await keyResponse.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("key").GetString()!;

        await using var connection = LiveTestSupport.Connect(hub.App, LiveTestSupport.Token(hub.App, owner.Id, owner.Email));
        var added = new TaskCompletionSource<CardDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<CardDto>("ServerAdded", c => added.TrySetResult(c));
        await connection.StartAsync(ct);
        await connection.InvokeAsync("SubscribeOverview", ct);

        using var anonymous = hub.CreateClient();
        var missing = await anonymous.PostAsJsonAsync("/api/e2e/enrol-fake-agent", new { hostname = "web-03" }, ct);
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        var bogus = await anonymous.PostAsJsonAsync("/api/e2e/enrol-fake-agent", new { key = "gp_not-a-key", hostname = "web-03" }, ct);
        Assert.Equal(HttpStatusCode.NotFound, bogus.StatusCode);

        var enrol = await anonymous.PostAsJsonAsync("/api/e2e/enrol-fake-agent", new { key, hostname = "web-03" }, ct);
        Assert.Equal(HttpStatusCode.OK, enrol.StatusCode);
        var body = await enrol.Content.ReadFromJsonAsync<JsonElement>(ct);
        var serverId = body.GetProperty("serverId").GetString()!;
        Assert.Equal("demo-web-03", serverId);
        Assert.Equal(owner.Id, body.GetProperty("ownerId").GetString());

        var card = await LiveTestSupport.WaitAsync(added);
        Assert.Equal(serverId, card.Id);
        Assert.Equal("web-03", card.Name);
        Assert.Equal("up", card.Status);
        Assert.True(card.Connected);
        Assert.Equal(2, card.Cores);
        Assert.Equal("24.04", card.VersionId);

        var list = await owner.Client.GetFromJsonAsync<JsonElement>("/api/servers", ct);
        var mine = list.EnumerateArray().Single(s => s.GetProperty("id").GetString() == serverId);
        Assert.Equal("owner", mine.GetProperty("role").GetString());
        Assert.Equal("web-03", mine.GetProperty("hostname").GetString());
        Assert.Equal("proxy", mine.GetProperty("dockerMode").GetString());

        // One-time: the same key is refused now, and the name is taken.
        var again = await anonymous.PostAsJsonAsync("/api/e2e/enrol-fake-agent", new { key, hostname = "web-04" }, ct);
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
        var taken = await anonymous.PostAsJsonAsync("/api/e2e/enrol-fake-agent", new { key = "gp_x", hostname = "web-03" }, ct);
        Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);

        // The new server streams like the others: a Card with numbers follows within a few seconds.
        var numbers = new TaskCompletionSource<CardDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<CardDto>("Card", c =>
        {
            if (c.Id == serverId && c.Cpu is not null && c.UptimeSec is not null)
            {
                numbers.TrySetResult(c);
            }
        });
        var live = await numbers.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
        Assert.InRange(live.Cpu!.Value, 1, 99);
        Assert.Equal(3, live.ContainersTotal);

        // PATCH name/tags reaches the live session too: the next Card carries the new name and the tag (step 4.4).
        var renamed = new TaskCompletionSource<CardDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<CardDto>("Card", c =>
        {
            if (c.Id == serverId && c.Name == "web-03-renamed")
            {
                renamed.TrySetResult(c);
            }
        });
        var patch = await owner.Client.PatchAsJsonAsync($"/api/servers/{serverId}", new { name = "web-03-renamed", tags = new[] { "e2e" } }, ct);
        Assert.Equal(HttpStatusCode.OK, patch.StatusCode);
        var afterPatch = await renamed.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
        Assert.Equal(["e2e"], afterPatch.Tags);
    }

    [Fact]
    public async Task Ensure_user_creates_a_confirmed_owner_and_a_reader_of_the_demo_servers()
    {
        var ct = Repo.Timeout(30);
        var demo = hub.Services.GetRequiredService<FakeAgentService>();
        await demo.Ready.WaitAsync(TimeSpan.FromSeconds(20), ct);
        using var anonymous = hub.CreateClient();

        var bad = await anonymous.PostAsJsonAsync("/api/e2e/ensure-user", new { email = "nope" }, ct);
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);

        // An owner without servers (screen 3): login works, the list is empty, and the call is idempotent.
        var ownerEmail = TestUsers.NewEmail("empty");
        var first = await anonymous.PostAsJsonAsync("/api/e2e/ensure-user", new { email = ownerEmail, password = "Owner-pass-2026" }, ct);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.True((await first.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("created").GetBoolean());
        var second = await anonymous.PostAsJsonAsync("/api/e2e/ensure-user", new { email = ownerEmail, password = "Owner-pass-2026" }, ct);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.False((await second.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("created").GetBoolean());

        using var ownerClient = hub.CreateClient();
        var (ownerToken, _) = await TestUsers.LoginRawAsync(ownerClient, ownerEmail, "Owner-pass-2026");
        using var owner = LiveTestSupport.Bearer(hub.App, ownerToken);
        var me = await owner.GetFromJsonAsync<JsonElement>("/api/auth/me", ct);
        Assert.True(me.GetProperty("emailConfirmed").GetBoolean());
        Assert.False(me.GetProperty("ownsServers").GetBoolean());
        Assert.Equal(0, me.GetProperty("readerOf").GetInt32());
        Assert.Empty((await owner.GetFromJsonAsync<JsonElement>("/api/servers", ct)).EnumerateArray());

        // A reader of the demo servers (screen 18): sixteen servers, all with role reader, none owned.
        var readerEmail = TestUsers.NewEmail("reader");
        var reader = await anonymous.PostAsJsonAsync("/api/e2e/ensure-user", new { email = readerEmail, readerOf = "all" }, ct);
        Assert.Equal(HttpStatusCode.OK, reader.StatusCode);
        Assert.True((await reader.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("reader").GetBoolean());

        using var readerLogin = hub.CreateClient();
        var (readerToken, _) = await TestUsers.LoginRawAsync(readerLogin, readerEmail, E2eUsers.DefaultPassword);
        using var readerApi = LiveTestSupport.Bearer(hub.App, readerToken);
        var readerMe = await readerApi.GetFromJsonAsync<JsonElement>("/api/auth/me", ct);
        Assert.False(readerMe.GetProperty("ownsServers").GetBoolean());
        Assert.Equal(1, readerMe.GetProperty("readerOf").GetInt32());
        var servers = (await readerApi.GetFromJsonAsync<JsonElement>("/api/servers", ct)).EnumerateArray().ToList();
        Assert.True(servers.Count >= DemoData.Definitions.Length, $"reader sees {servers.Count} servers");
        Assert.All(servers, s => Assert.Equal("reader", s.GetProperty("role").GetString()));
        Assert.Contains(servers, s => s.GetProperty("id").GetString() == "demo-web-01");
        Assert.Equal(HttpStatusCode.Forbidden, (await readerApi.PatchAsJsonAsync("/api/servers/demo-web-01", new { name = "mine" }, ct)).StatusCode);
    }
}
