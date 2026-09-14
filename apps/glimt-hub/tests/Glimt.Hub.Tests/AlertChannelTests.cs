using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Glimt.Hub.Features.Access;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Alerts.Channels;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace Glimt.Hub.Tests;

/// <summary>Channel selection, the webhook signature and retries, the digest schedule and the mail templates (step 7.2).</summary>
public sealed class AlertChannelTests
{
    private static AlertEvent Event(string rule, string kind = AlertEventKinds.Fired, string severity = AlertSeverities.Critical) =>
        new(kind, new AlertDocument { ServerId = "s1", OwnerId = "owner", Rule = rule, Key = "/", Severity = severity, Detail = "/ · 92 %", FiredAt = new DateTime(2026, 9, 14, 6, 11, 0, DateTimeKind.Utc) }, "web-02", "owner", "Europe/Oslo", false);

    private static UserDocument User(string id, string language = "en") => new() { Id = id, Email = id + "@test.local", Name = id, Language = language, Timezone = "Europe/Oslo" };

    [Fact]
    public void Dispatcher_picks_channels_by_severity_role_and_settings()
    {
        var settings = AlertSettingsDocument.Defaults("owner");
        var owner = new AlertNotification(Event(AlertRuleIds.DiskFull), User("owner"), settings, IsOwner: true);
        var reader = new AlertNotification(Event(AlertRuleIds.DiskFull), User("reader"), AlertSettingsDocument.Defaults("reader"), IsOwner: false);

        Assert.True(NotificationDispatcher.Wants(ChannelNames.Push, owner));
        Assert.True(NotificationDispatcher.Wants(ChannelNames.Push, reader));
        Assert.True(NotificationDispatcher.Wants(ChannelNames.Email, owner));
        Assert.False(NotificationDispatcher.Wants(ChannelNames.Email, reader));
        Assert.False(NotificationDispatcher.Wants(ChannelNames.Webhook, owner));

        settings.Channels.Push = false;
        settings.Channels.Email = false;
        settings.Channels.WebhookUrl = "https://hooks.example/abc";
        Assert.False(NotificationDispatcher.Wants(ChannelNames.Push, owner));
        // server_down and disk_full are always e-mailed to the owner; memory pressure honours the switch.
        Assert.True(NotificationDispatcher.Wants(ChannelNames.Email, owner));
        Assert.False(NotificationDispatcher.Wants(ChannelNames.Email, new AlertNotification(Event(AlertRuleIds.MemPressure, severity: AlertSeverities.Warning), User("owner"), settings, true)));
        Assert.True(NotificationDispatcher.Wants(ChannelNames.Webhook, owner));
        Assert.False(NotificationDispatcher.Wants(ChannelNames.Webhook, new AlertNotification(Event(AlertRuleIds.DiskFull), User("reader"), settings, false)));
    }

    [Fact]
    public async Task Dispatcher_skips_quiet_and_info_events_and_records_notified_via()
    {
        var store = new InMemoryAlertStore();
        var channel = new FakeChannel(ChannelNames.Push);
        var dispatcher = new NotificationDispatcher([channel], new FakeAccess(["owner", "reader"]), new FakeUsers([User("owner"), User("reader")]), store, NullLogger<NotificationDispatcher>.Instance);

        var fired = Event(AlertRuleIds.DiskFull);
        store.Alerts.Add(fired.Alert);
        await dispatcher.OnAlertAsync(fired, CancellationToken.None);
        Assert.Equal(2, channel.Sent.Count);
        Assert.Contains(channel.Sent, n => n.IsOwner && n.User.Id == "owner");
        Assert.Contains(channel.Sent, n => !n.IsOwner && n.User.Id == "reader");
        Assert.Equal(["push"], fired.Alert.NotifiedVia);

        await dispatcher.OnAlertAsync(Event(AlertRuleIds.Reboot, severity: AlertSeverities.Info), CancellationToken.None);
        await dispatcher.OnAlertAsync(Event(AlertRuleIds.DiskFull) with { Quiet = true }, CancellationToken.None);
        Assert.Equal(2, channel.Sent.Count);

        await dispatcher.OnAlertAsync(Event(AlertRuleIds.DiskFull, AlertEventKinds.Resolved), CancellationToken.None);
        Assert.Equal(4, channel.Sent.Count);
    }

    [Fact]
    public async Task Webhook_posts_signed_json_and_retries_until_2xx()
    {
        var handler = new SequenceHandler(HttpStatusCode.BadGateway, HttpStatusCode.OK);
        var channel = new WebhookChannel(new WebPushTests.SingleHandlerFactory(handler), Sessions(), NullLogger<WebhookChannel>.Instance, [TimeSpan.Zero, TimeSpan.Zero, TimeSpan.Zero], background: false);
        var settings = AlertSettingsDocument.Defaults("owner");
        settings.Channels.WebhookUrl = "https://hooks.example/abc";
        var sent = await channel.SendAsync(new AlertNotification(Event(AlertRuleIds.DiskFull), User("owner"), settings, true), CancellationToken.None);

        Assert.True(sent);
        Assert.Equal(2, handler.Requests.Count);
        var (headers, body) = handler.Requests[1];
        var expected = "sha256=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(settings.Channels.WebhookSecret), body));
        Assert.Equal(expected, headers[WebhookChannel.SignatureHeader]);
        var json = JsonSerializer.Deserialize<JsonElement>(body);
        Assert.Equal("fired", json.GetProperty("event").GetString());
        Assert.Equal("web-02", json.GetProperty("server").GetProperty("name").GetString());
        Assert.Equal("disk_full", json.GetProperty("rule").GetString());
        Assert.Equal("critical", json.GetProperty("severity").GetString());
        Assert.Equal("/ · 92 %", json.GetProperty("detail").GetString());
        Assert.Equal("2026-09-14T06:11:00.0000000+00:00", json.GetProperty("at").GetString());
        Assert.Equal("http://localhost:4200/servers/s1#disk", json.GetProperty("url").GetString());

        // Three failures: gives up, no exception.
        var failing = new SequenceHandler(HttpStatusCode.InternalServerError, HttpStatusCode.InternalServerError, HttpStatusCode.InternalServerError);
        var stubborn = new WebhookChannel(new WebPushTests.SingleHandlerFactory(failing), Sessions(), NullLogger<WebhookChannel>.Instance, [TimeSpan.Zero, TimeSpan.Zero, TimeSpan.Zero], background: false);
        Assert.False(await stubborn.SendAsync(new AlertNotification(Event(AlertRuleIds.DiskFull), User("owner"), settings, true), CancellationToken.None));
        Assert.Equal(3, failing.Requests.Count);

        // No URL, or a reader: nothing.
        Assert.False(await channel.SendAsync(new AlertNotification(Event(AlertRuleIds.DiskFull), User("reader"), settings, false), CancellationToken.None));
        Assert.False(await channel.SendAsync(new AlertNotification(Event(AlertRuleIds.DiskFull), User("owner"), AlertSettingsDocument.Defaults("owner"), true), CancellationToken.None));
    }

    [Fact]
    public void Digest_is_due_at_the_local_digest_time_once_per_local_date()
    {
        var oslo = AlertSettingsDocument.Defaults("oslo");
        var newYork = AlertSettingsDocument.Defaults("ny");

        // 06:00 UTC = 08:00 in Oslo (CEST), 02:00 in New York.
        var at0600 = new DateTimeOffset(2026, 9, 14, 6, 0, 0, TimeSpan.Zero);
        Assert.True(DigestService.IsDue(oslo, "Europe/Oslo", at0600, out var osloDate));
        Assert.Equal("2026-09-14", osloDate);
        Assert.False(DigestService.IsDue(newYork, "America/New_York", at0600, out _));

        // 12:00 UTC = 08:00 in New York (EDT).
        var at1200 = new DateTimeOffset(2026, 9, 14, 12, 0, 0, TimeSpan.Zero);
        Assert.False(DigestService.IsDue(oslo, "Europe/Oslo", at1200, out _));
        Assert.True(DigestService.IsDue(newYork, "America/New_York", at1200, out _));

        // Already sent today: not due again; 08:01 is not due either.
        oslo.LastDigestDate = "2026-09-14";
        Assert.False(DigestService.IsDue(oslo, "Europe/Oslo", at0600, out _));
        Assert.False(DigestService.IsDue(newYork, "America/New_York", at1200.AddMinutes(1), out _));

        // A custom time and an unknown zone (falls back to UTC).
        newYork.Digest.Time = "21:30";
        Assert.True(DigestService.IsDue(newYork, "Nowhere/Land", new DateTimeOffset(2026, 9, 14, 21, 30, 0, TimeSpan.Zero), out _));
        Assert.False(DigestService.IsDue(newYork, "America/New_York", new DateTimeOffset(2026, 9, 14, 21, 30, 0, TimeSpan.Zero), out _));
    }

    [Fact]
    public void Alert_mails_use_the_recipients_language_and_zone()
    {
        var fired = AlertEmailTemplates.Alert("ole@test.local", "no", "Europe/Oslo", Event(AlertRuleIds.DiskFull), "http://localhost:4200/servers/s1#disk");
        Assert.Equal("[Glimtpanel] web-02 · Disk nesten full", fired.Subject);
        Assert.Contains("(Sep 14 08:11)", fired.Text);
        Assert.Contains("/ · 92 %", fired.Text);
        Assert.Contains(WebUtility.HtmlEncode("Åpne i Glimtpanel"), fired.Html);

        var resolved = AlertEmailTemplates.Alert("ole@test.local", "en", "UTC", Event(AlertRuleIds.DiskFull, AlertEventKinds.Resolved), "http://x");
        Assert.Equal("[Glimtpanel] web-02 · Disk almost full · resolved", resolved.Subject);
        Assert.Contains("is resolved (Sep 14 06:11)", resolved.Text);

        var digest = AlertEmailTemplates.Digest("ole@test.local", "en", "Europe/Oslo", [(Event(AlertRuleIds.Reboot, severity: AlertSeverities.Info).Alert, "db-prod")], [(Event(AlertRuleIds.DiskFull).Alert, "web-02")], "http://x/alerts");
        Assert.Equal("[Glimtpanel] Daily summary", digest.Subject);
        Assert.Contains("Still firing (1):", digest.Text);
        Assert.Contains("• web-02 · Disk almost full · / · 92 % · Sep 14 08:11", digest.Text);
        Assert.Contains("Info in the last 24 hours (1):", digest.Text);
        Assert.Contains("• db-prod · Reboot required", digest.Text);
    }

    [Fact]
    public void Silence_until_is_computed_in_the_users_zone()
    {
        // Saturday 2026-09-12 20:00 UTC = 22:00 in Oslo.
        var now = new DateTimeOffset(2026, 9, 12, 20, 0, 0, TimeSpan.Zero);
        Assert.Equal(now.AddHours(1), AlertEndpoints.SilenceUntil("1h", now, "Europe/Oslo"));
        Assert.Equal(new DateTimeOffset(2026, 9, 13, 6, 0, 0, TimeSpan.Zero), AlertEndpoints.SilenceUntil("tomorrow", now, "Europe/Oslo"));
        Assert.Equal(new DateTimeOffset(2026, 9, 14, 6, 0, 0, TimeSpan.Zero), AlertEndpoints.SilenceUntil("monday", now, "Europe/Oslo"));
        // On a Monday "monday" means next week.
        var monday = new DateTimeOffset(2026, 9, 14, 10, 0, 0, TimeSpan.Zero);
        Assert.Equal(new DateTimeOffset(2026, 9, 21, 6, 0, 0, TimeSpan.Zero), AlertEndpoints.SilenceUntil("monday", monday, "Europe/Oslo"));
        // Unknown zone: UTC.
        Assert.Equal(new DateTimeOffset(2026, 9, 13, 8, 0, 0, TimeSpan.Zero), AlertEndpoints.SilenceUntil("tomorrow", now, null));
    }

    private static AuthSessions Sessions()
    {
        var options = new GlimtOptions { Env = GlimtOptions.E2e, MongoUri = HubFactory.UnreachableMongoUri, MongoDb = "t", JwtSecret = "t", HubUrl = "http://localhost:5080", WebPublicUrl = "http://localhost:4200" };
        var mongo = new MongoContext(options, NullLogger<MongoContext>.Instance);
        var clock = new FakeTimeProvider();
        return new AuthSessions(new Infrastructure.Auth.JwtTokens(options, clock), new RefreshTokenStore(mongo, clock), new InMemoryServerStore(), new AccessGrantStore(mongo), options, clock);
    }

    private sealed class FakeAccess(string[] userIds) : Infrastructure.Access.IAccessService
    {
        public Task<IReadOnlyList<string>> VisibleServerIdsAsync(string userId, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<string>>(["s1"]);

        public Task<bool> CanReadAsync(string userId, string serverId, CancellationToken cancellationToken) => Task.FromResult(userIds.Contains(userId));

        public Task<bool> IsOwnerAsync(string userId, string serverId, CancellationToken cancellationToken) => Task.FromResult(userId == "owner");

        public Task<IReadOnlyList<string>> UserIdsWithAccessAsync(string serverId, CancellationToken cancellationToken) => Task.FromResult<IReadOnlyList<string>>(userIds);
    }

    /// <summary>A UserStore whose FindByIdsAsync answers from a list (the base class needs MongoDB for everything else).</summary>
    private sealed class FakeUsers(IReadOnlyList<UserDocument> users) : IUserLookup
    {
        public Task<IReadOnlyList<UserDocument>> FindByIdsAsync(IEnumerable<string> ids, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<UserDocument>>(users.Where(u => ids.Contains(u.Id)).ToList());
    }

    internal sealed class SequenceHandler(params HttpStatusCode[] statuses) : HttpMessageHandler
    {
        public List<(Dictionary<string, string> Headers, byte[] Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
            Requests.Add((headers, await request.Content!.ReadAsByteArrayAsync(cancellationToken)));
            return new HttpResponseMessage(statuses[Math.Min(Requests.Count - 1, statuses.Length - 1)]);
        }
    }
}
