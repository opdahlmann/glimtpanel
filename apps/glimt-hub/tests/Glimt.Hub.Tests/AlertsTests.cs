using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Alerts.Channels;
using Glimt.Hub.Features.Demo;
using Glimt.Hub.Features.Live;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Glimt.Hub.Tests;

/// <summary>
/// The alert endpoints and the whole path from a fake agent's snapshot to the browser and the channels, against MongoDB
/// (Testcontainers). The demo servers are owned by the dev user, so the dev token sees their alerts.
/// </summary>
public sealed class AlertsTests : IAsyncLifetime
{
    private HubFactory _root = null!;
    private WebApplicationFactory<Program> _app = null!;
    private readonly FakeChannel _push = new(ChannelNames.Push);
    private readonly FakeChannel _email = new(ChannelNames.Email);
    private string _devUserId = "";

    public async Task InitializeAsync()
    {
        _root = HubFactory.WithMongo();
        _app = _root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.RemoveAll(typeof(IChannel));
            services.AddSingleton<IChannel>(_push);
            services.AddSingleton<IChannel>(_email);
        }));
        var mongo = _app.Services.GetRequiredService<Infrastructure.MongoContext>();
        Assert.True(await mongo.Ready.WaitAsync(TimeSpan.FromSeconds(30)));
        await _app.Services.GetRequiredService<FakeAgentService>().Ready.WaitAsync(TimeSpan.FromSeconds(15));
        _devUserId = (await _app.Services.GetRequiredService<UserDirectory>().DevUserIdAsync(CancellationToken.None))!;
        Assert.Equal(_devUserId, _app.Services.GetRequiredService<FakeAgentService>().OwnerId);
    }

    public Task DisposeAsync()
    {
        _app.Dispose();
        _root.Dispose();
        return Task.CompletedTask;
    }

    private HttpClient Dev() => LiveTestSupport.Bearer(_app, LiveTestSupport.Token(_app, _devUserId));

    [Fact]
    public async Task Demo_servers_produce_alerts_that_are_listed_and_pushed()
    {
        var ct = Repo.Timeout(30);
        using var client = Dev();

        // web-02 has 92 % on /, worker-01 a failed unit, db-prod reboot required (info), nordic-db is down since 03:12.
        await _app.Services.GetRequiredService<AlertEngine>().SweepAsync(ct);
        JsonElement list = default;
        await WaitAsync(async () =>
        {
            list = await client.GetFromJsonAsync<JsonElement>("/api/alerts?state=active", ct);
            return list.GetProperty("active").GetInt32() >= 4;
        });
        var rows = list.GetProperty("alerts").EnumerateArray().ToList();
        var disk = rows.Single(r => r.GetProperty("serverId").GetString() == "demo-web-02" && r.GetProperty("rule").GetString() == "disk_full");
        Assert.Equal("/ · 92 %", disk.GetProperty("detail").GetString());
        Assert.Equal("web-02", disk.GetProperty("serverName").GetString());
        Assert.Equal("critical", disk.GetProperty("severity").GetString());
        Assert.Equal("firing", disk.GetProperty("state").GetString());
        Assert.False(disk.GetProperty("silenced").GetBoolean());
        Assert.Contains(rows, r => r.GetProperty("serverId").GetString() == "demo-worker-01" && r.GetProperty("rule").GetString() == "svc_failed" && r.GetProperty("detail").GetString() == "cron-sync.service");
        Assert.Contains(rows, r => r.GetProperty("serverId").GetString() == "demo-db-prod" && r.GetProperty("rule").GetString() == "reboot" && r.GetProperty("severity").GetString() == "info");
        var down = rows.Single(r => r.GetProperty("serverId").GetString() == "demo-nordic-db");
        Assert.Equal("server_down", down.GetProperty("rule").GetString());
        Assert.StartsWith("last seen ", down.GetProperty("detail").GetString());

        // The owner got push and e-mail for the critical ones, nothing for the info alert.
        await WaitAsync(() => Task.FromResult(_email.Sent.Any(n => n.Event.Alert.Rule == "disk_full")));
        Assert.Contains(_push.Sent, n => n.User.Id == _devUserId && n.Event.Alert.ServerId == "demo-web-02");
        Assert.DoesNotContain(_push.Sent, n => n.Event.Alert.Rule == "reboot");
        Assert.DoesNotContain(_email.Sent, n => n.Event.Alert.Rule == "reboot");

        // The cards carry the counts.
        await using var connection = LiveTestSupport.Connect(_app, LiveTestSupport.Token(_app, _devUserId));
        var card = new TaskCompletionSource<CardDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<CardDto>("Card", c =>
        {
            if (c.Id == "demo-web-02")
            {
                card.TrySetResult(c);
            }
        });
        await connection.StartAsync(ct);
        await connection.InvokeAsync("SubscribeOverview", ct);
        var web02 = await LiveTestSupport.WaitAsync(card);
        Assert.True(web02.ActiveAlerts >= 1);
        Assert.Equal("critical", web02.AlertSeverity);

        // Silence web-02 for an hour: the row shows silenced; a reader may not.
        var silence = await client.PostAsJsonAsync("/api/alerts/silence", new { serverId = "demo-web-02", until = "1h" }, ct);
        Assert.Equal(HttpStatusCode.OK, silence.StatusCode);
        var silenced = await silence.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.NotNull(silenced.GetProperty("silencedUntil").GetString());
        list = await client.GetFromJsonAsync<JsonElement>("/api/alerts?state=active", ct);
        Assert.True(list.GetProperty("alerts").EnumerateArray().Single(r => r.GetProperty("id").GetString() == disk.GetProperty("id").GetString()).GetProperty("silenced").GetBoolean());

        using var reader = LiveTestSupport.Bearer(_app, LiveTestSupport.Token(_app, "someone-else", "other@test.local"));
        Assert.Equal(HttpStatusCode.Forbidden, (await reader.PostAsJsonAsync("/api/alerts/silence", new { serverId = "demo-web-02", until = "1h" }, ct)).StatusCode);
        var empty = await reader.GetFromJsonAsync<JsonElement>("/api/alerts", ct);
        Assert.Equal(0, empty.GetProperty("alerts").GetArrayLength());
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/alerts/silence", new { serverId = "demo-web-02", until = "forever" }, ct)).StatusCode);
    }

    [Fact]
    public async Task Alert_event_reaches_the_browser_when_a_service_fails()
    {
        var ct = Repo.Timeout(30);
        await using var connection = LiveTestSupport.Connect(_app, LiveTestSupport.Token(_app, _devUserId));
        var fired = new TaskCompletionSource<AlertEventDto>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<AlertEventDto>("Alert", e =>
        {
            if (e.Alert.ServerId == "demo-web-01" && e.Alert.Rule == "svc_failed")
            {
                fired.TrySetResult(e);
            }
        });
        await connection.StartAsync(ct);
        await connection.InvokeAsync("SubscribeOverview", ct);

        using var client = Dev();
        var fail = await client.PostAsJsonAsync("/api/e2e/fail-service", new { serverId = "demo-web-01", unit = "backup.service" }, ct);
        Assert.Equal(HttpStatusCode.OK, fail.StatusCode);
        var e = await LiveTestSupport.WaitAsync(fired, 10);
        Assert.Equal("fired", e.Kind);
        Assert.Equal("backup.service", e.Alert.Detail);
        Assert.Equal("web-01", e.Alert.ServerName);
        Assert.True(e.ActiveOnServer >= 1);
        Assert.Equal("warning", e.WorstSeverity);
    }

    [Fact]
    public async Task Settings_channels_server_overrides_and_push_subscriptions_round_trip()
    {
        var ct = Repo.Timeout(30);
        using var client = Dev();

        var settings = await client.GetFromJsonAsync<JsonElement>("/api/alert-settings", ct);
        var rules = settings.GetProperty("rules").EnumerateArray().ToList();
        Assert.Equal(7, rules.Count);
        var disk = rules.Single(r => r.GetProperty("id").GetString() == "disk_full");
        Assert.Equal(90, disk.GetProperty("threshold").GetDouble());
        Assert.Equal(90, disk.GetProperty("defaultThreshold").GetDouble());
        Assert.Equal("percent", disk.GetProperty("thresholdUnit").GetString());
        Assert.True(disk.GetProperty("enabled").GetBoolean());
        Assert.True(settings.GetProperty("channels").GetProperty("push").GetBoolean());
        Assert.StartsWith("whs_", settings.GetProperty("channels").GetProperty("webhookSecret").GetString());
        Assert.Equal("08:00", settings.GetProperty("digest").GetProperty("time").GetString());
        Assert.Equal("dev@glimtpanel.local", settings.GetProperty("email").GetString());

        // Account: memory at 90 % for 10 min, cpu off.
        var put = await client.PutAsJsonAsync("/api/alert-settings", new { rules = new { mem_pressure = new { threshold = 90, durationSec = 600 }, cpu_sat = new { enabled = false } } }, ct);
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var updated = await put.Content.ReadFromJsonAsync<JsonElement>(ct);
        var mem = updated.GetProperty("rules").EnumerateArray().Single(r => r.GetProperty("id").GetString() == "mem_pressure");
        Assert.Equal(90, mem.GetProperty("threshold").GetDouble());
        Assert.Equal(600, mem.GetProperty("durationSec").GetInt32());
        Assert.False(updated.GetProperty("rules").EnumerateArray().Single(r => r.GetProperty("id").GetString() == "cpu_sat").GetProperty("enabled").GetBoolean());
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync("/api/alert-settings", new { rules = new { disk_full = new { threshold = 250 } } }, ct)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync("/api/alert-settings", new { rules = new { nonsense = new { enabled = false } } }, ct)).StatusCode);

        // Channels.
        var channels = await client.PutAsJsonAsync("/api/channels", new { push = false, webhookUrl = "https://hooks.example/abc", digest = new { enabled = false, time = "21:30" } }, ct);
        Assert.Equal(HttpStatusCode.OK, channels.StatusCode);
        var ch = await channels.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.False(ch.GetProperty("channels").GetProperty("push").GetBoolean());
        Assert.Equal("https://hooks.example/abc", ch.GetProperty("channels").GetProperty("webhookUrl").GetString());
        Assert.False(ch.GetProperty("digest").GetProperty("enabled").GetBoolean());
        Assert.Equal("21:30", ch.GetProperty("digest").GetProperty("time").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync("/api/channels", new { webhookUrl = "not a url" }, ct)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsJsonAsync("/api/channels", new { digest = new { enabled = true, time = "9am" } }, ct)).StatusCode);

        // Server override on web-02: disk at 95 %, mute.
        var server = await client.GetFromJsonAsync<JsonElement>("/api/servers/demo-web-02/alert-settings", ct);
        Assert.True(server.GetProperty("useAccountDefaults").GetBoolean());
        Assert.Equal("web-02", server.GetProperty("serverName").GetString());
        var over = await client.PutAsJsonAsync("/api/servers/demo-web-02/alert-settings", new { rules = new { disk_full = new { threshold = 95 } }, muted = true }, ct);
        Assert.Equal(HttpStatusCode.OK, over.StatusCode);
        var o = await over.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.False(o.GetProperty("useAccountDefaults").GetBoolean());
        Assert.True(o.GetProperty("muted").GetBoolean());
        var overDisk = o.GetProperty("rules").EnumerateArray().Single(r => r.GetProperty("id").GetString() == "disk_full");
        Assert.Equal(95, overDisk.GetProperty("threshold").GetDouble());
        Assert.Equal(90, overDisk.GetProperty("defaultThreshold").GetDouble());
        Assert.True(overDisk.GetProperty("overridden").GetBoolean());
        var back = await client.PutAsJsonAsync("/api/servers/demo-web-02/alert-settings", new { useAccountDefaults = true, muted = false }, ct);
        Assert.True((await back.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("useAccountDefaults").GetBoolean());
        using var stranger = LiveTestSupport.Bearer(_app, LiveTestSupport.Token(_app, "stranger", "stranger@test.local"));
        Assert.Equal(HttpStatusCode.Forbidden, (await stranger.GetAsync("/api/servers/demo-web-02/alert-settings", ct)).StatusCode);

        // Push subscriptions: add, listed as a device, delete.
        var sub = await client.PostAsJsonAsync("/api/push-subscriptions", new { endpoint = "https://push.example/e2e/1", keys = new { p256dh = "BP" + new string('A', 85), auth = new string('B', 22) }, device = "iPhone · Safari" }, ct);
        Assert.Equal(HttpStatusCode.Created, sub.StatusCode);
        var withDevice = await client.GetFromJsonAsync<JsonElement>("/api/alert-settings", ct);
        var devices = withDevice.GetProperty("pushDevices").EnumerateArray().ToList();
        Assert.Contains(devices, d => d.GetProperty("device").GetString() == "iPhone · Safari");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/push-subscriptions", new { endpoint = "http://insecure", keys = new { p256dh = "x", auth = "y" } }, ct)).StatusCode);
        using var del = new HttpRequestMessage(HttpMethod.Delete, "/api/push-subscriptions") { Content = JsonContent.Create(new { endpoint = "https://push.example/e2e/1" }) };
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(del, ct)).StatusCode);
        var without = await client.GetFromJsonAsync<JsonElement>("/api/alert-settings", ct);
        Assert.DoesNotContain(without.GetProperty("pushDevices").EnumerateArray(), d => d.GetProperty("device").GetString() == "iPhone · Safari");

        // Export carries the settings.
        var export = await client.GetFromJsonAsync<JsonElement>("/api/account/export", ct);
        Assert.Equal("21:30", export.GetProperty("alertSettings").GetProperty("digest").GetProperty("time").GetString());
    }

    private static async Task WaitAsync(Func<Task<bool>> condition, int seconds = 15)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < until)
        {
            if (await condition())
            {
                return;
            }

            await Task.Delay(200);
        }

        Assert.Fail("condition not met within " + seconds + " s");
    }
}
