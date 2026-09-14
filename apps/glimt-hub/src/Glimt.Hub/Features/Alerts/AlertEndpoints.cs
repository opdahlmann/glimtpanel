using System.Globalization;
using System.Security.Claims;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Alerts.Channels;
using Glimt.Hub.Features.Alerts.Push;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Access;
using Glimt.Hub.Infrastructure.Auth;
using Microsoft.AspNetCore.Mvc;

namespace Glimt.Hub.Features.Alerts;

/// <summary>/api/alerts, /api/alert-settings, /api/servers/{id}/alert-settings, /api/channels, /api/push-subscriptions (IMPLEMENTERINGSPLAN 4.3, steps 7.1–7.4).</summary>
public static class AlertEndpoints
{
    public const int ListLimit = 200;
    public static readonly string[] SilenceChoices = ["1h", "tomorrow", "monday"];

    public static IEndpointRouteBuilder MapAlertEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api")
            .RequireAuthorization()
            .RequireRateLimiting(RateLimiting.ApiPolicy)
            .AddEndpointFilter<RequireDatabase>();
        group.MapGet("/alerts", ListAsync);
        group.MapPost("/alerts/silence", SilenceAsync);
        group.MapGet("/alert-settings", GetSettingsAsync);
        group.MapPut("/alert-settings", PutSettingsAsync);
        group.MapPut("/channels", PutChannelsAsync);
        group.MapPost("/channels/webhook-test", WebhookTestAsync);
        group.MapGet("/servers/{id}/alert-settings", GetServerSettingsAsync);
        group.MapPut("/servers/{id}/alert-settings", PutServerSettingsAsync);
        group.MapPost("/push-subscriptions", AddPushSubscriptionAsync);
        group.MapDelete("/push-subscriptions", DeletePushSubscriptionAsync);
        return app;
    }

    // ---- alerts ------------------------------------------------------------------------------------

    private static async Task<IResult> ListAsync(
        [FromQuery] string? state,
        ClaimsPrincipal principal,
        IAccessService access,
        IAlertStore alerts,
        IServerStore servers,
        AgentRegistry registry,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var wanted = state?.Trim().ToLowerInvariant() switch
        {
            null or "" or "all" => null,
            "active" or AlertStates.Firing => AlertStates.Firing,
            AlertStates.Resolved => AlertStates.Resolved,
            _ => "invalid",
        };
        if (wanted == "invalid")
        {
            return Validation.ValidationProblem("state", "state must be active, resolved or all.");
        }

        var visible = await access.VisibleServerIdsAsync(principal.RequireUserId(), cancellationToken);
        var all = await alerts.ListByServersAsync(visible, null, ListLimit, cancellationToken);
        var docs = await servers.ListByIdsAsync(all.Select(a => a.ServerId).Distinct().ToList(), cancellationToken);
        var byId = docs.ToDictionary(d => d.Id, StringComparer.Ordinal);
        var now = clock.GetUtcNow();
        var rows = all
            .Where(a => wanted is null || a.State == wanted)
            .Select(a => AlertDto.From(a, Name(a.ServerId, byId, registry), IsSilenced(a, byId, now)))
            .ToList();
        return Results.Ok(new AlertListResponse(rows, all.Count(a => a.State == AlertStates.Firing), all.Count(a => a.State == AlertStates.Resolved)));
    }

    private static async Task<IResult> SilenceAsync(
        SilenceRequest request,
        ClaimsPrincipal principal,
        IAccessService access,
        IServerStore servers,
        UserStore users,
        AlertConfigProvider config,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var until = request.Until?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(request.ServerId) || until is null || !SilenceChoices.Contains(until))
        {
            return Validation.ValidationProblem("until", "until must be 1h, tomorrow or monday, and serverId is required.");
        }

        var userId = principal.RequireUserId();
        if (!await access.IsOwnerAsync(userId, request.ServerId, cancellationToken))
        {
            return Validation.Forbidden("Only the owner can silence a server");
        }

        var user = await users.FindByIdAsync(userId, cancellationToken);
        var silencedUntil = SilenceUntil(until, clock.GetUtcNow(), user?.Timezone);
        if (!await servers.SilenceAsync(request.ServerId, silencedUntil.UtcDateTime, cancellationToken))
        {
            return Validation.NotFound("Server not found");
        }

        config.Invalidate(request.ServerId);
        return Results.Ok(new SilenceResponse(request.ServerId, silencedUntil));
    }

    /// <summary>1h = now + 1 h; tomorrow = 08:00 the next day; monday = 08:00 next Monday (a week ahead when today is Monday), in the user's zone.</summary>
    public static DateTimeOffset SilenceUntil(string choice, DateTimeOffset now, string? timezone)
    {
        if (choice == "1h")
        {
            return now + TimeSpan.FromHours(1);
        }

        var zone = !string.IsNullOrWhiteSpace(timezone) && TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out var tz) ? tz : TimeZoneInfo.Utc;
        var local = TimeZoneInfo.ConvertTime(now, zone);
        var days = choice == "monday" ? ((int)DayOfWeek.Monday - (int)local.DayOfWeek + 7) % 7 : 1;
        if (days == 0)
        {
            days = 7;
        }

        var date = local.Date.AddDays(days).AddHours(8);
        return new DateTimeOffset(date, zone.GetUtcOffset(date)).ToUniversalTime();
    }

    // ---- account settings --------------------------------------------------------------------------

    private static async Task<IResult> GetSettingsAsync(
        ClaimsPrincipal principal,
        UserStore users,
        IAlertStore alerts,
        IWebPushClient push,
        CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        var settings = await alerts.GetSettingsAsync(user.Id, cancellationToken) ?? AlertSettingsDocument.Defaults(user.Id);
        var devices = await alerts.ListSubscriptionsAsync([user.Id], cancellationToken);
        return Results.Ok(ToDto(settings, devices, user.Email, push.IsConfigured));
    }

    private static async Task<IResult> PutSettingsAsync(
        PutAlertSettingsRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        IAlertStore alerts,
        AlertConfigProvider config,
        IWebPushClient push,
        CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        var settings = await alerts.GetSettingsAsync(user.Id, cancellationToken) ?? AlertSettingsDocument.Defaults(user.Id);
        var rules = ValidateRules(request.Rules, out var errors);
        if (errors.Count > 0)
        {
            return Validation.ValidationProblem(errors);
        }

        settings.Rules = rules;
        await alerts.UpsertSettingsAsync(settings, cancellationToken);
        config.InvalidateOwner(user.Id);
        var devices = await alerts.ListSubscriptionsAsync([user.Id], cancellationToken);
        return Results.Ok(ToDto(settings, devices, user.Email, push.IsConfigured));
    }

    private static async Task<IResult> PutChannelsAsync(
        PutChannelsRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        IAlertStore alerts,
        AlertConfigProvider config,
        IWebPushClient push,
        CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        var errors = new Dictionary<string, string[]>();
        string? webhookUrl = null;
        if (request.WebhookUrl is not null)
        {
            webhookUrl = request.WebhookUrl.Trim();
            if (webhookUrl.Length > 0 && (webhookUrl.Length > 2048 || !WebhookChannel.IsValidUrl(webhookUrl)))
            {
                errors["webhookUrl"] = ["Enter an absolute http(s) URL."];
            }
        }

        if (request.Digest is { } digest && !IsTime(digest.Time))
        {
            errors["digest"] = ["Time must be HH:mm."];
        }

        if (errors.Count > 0)
        {
            return Validation.ValidationProblem(errors);
        }

        var settings = await alerts.GetSettingsAsync(user.Id, cancellationToken) ?? AlertSettingsDocument.Defaults(user.Id);
        if (request.Push is { } p)
        {
            settings.Channels.Push = p;
        }

        if (request.Email is { } e)
        {
            settings.Channels.Email = e;
        }

        if (webhookUrl is not null)
        {
            settings.Channels.WebhookUrl = webhookUrl.Length == 0 ? null : webhookUrl;
        }

        if (request.RotateWebhookSecret == true)
        {
            settings.Channels.WebhookSecret = ChannelsDocument.NewSecret();
        }

        if (request.Digest is { } d)
        {
            settings.Digest = new DigestDocument { Enabled = d.Enabled, Time = d.Time };
        }

        await alerts.UpsertSettingsAsync(settings, cancellationToken);
        config.InvalidateOwner(user.Id);
        var devices = await alerts.ListSubscriptionsAsync([user.Id], cancellationToken);
        return Results.Ok(ToDto(settings, devices, user.Email, push.IsConfigured));
    }

    private static async Task<IResult> WebhookTestAsync(
        ClaimsPrincipal principal,
        UserStore users,
        IAlertStore alerts,
        WebhookChannel webhook,
        AuthSessions sessions,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        var settings = await alerts.GetSettingsAsync(user.Id, cancellationToken);
        var url = settings?.Channels.WebhookUrl;
        if (settings is null || string.IsNullOrWhiteSpace(url))
        {
            return Validation.ValidationProblem("webhookUrl", "Save a webhook URL first.");
        }

        var payload = new WebhookPayload("test", new WebhookServer("test", "glimtpanel"), "test", AlertSeverities.Info, "This is a test from Glimtpanel", clock.GetUtcNow().ToString("o"), sessions.WebLink("/settings/alerts"));
        var status = await webhook.TryOnceAsync(url, settings.Channels.WebhookSecret, payload, cancellationToken);
        return Results.Ok(new WebhookTestResponse(status is >= 200 and < 300, status));
    }

    // ---- per-server settings -----------------------------------------------------------------------

    private static async Task<IResult> GetServerSettingsAsync(
        string id,
        ClaimsPrincipal principal,
        IAccessService access,
        IServerStore servers,
        IAlertStore alerts,
        CancellationToken cancellationToken)
    {
        var userId = principal.RequireUserId();
        if (!await access.IsOwnerAsync(userId, id, cancellationToken))
        {
            return Validation.Forbidden("Only the owner can see a server's alert settings");
        }

        var doc = await servers.FindAsync(id, cancellationToken);
        if (doc is null)
        {
            return Validation.NotFound("Server not found");
        }

        var settings = await alerts.GetSettingsAsync(userId, cancellationToken);
        return Results.Ok(ToServerDto(doc, settings));
    }

    private static async Task<IResult> PutServerSettingsAsync(
        string id,
        PutServerAlertSettingsRequest request,
        ClaimsPrincipal principal,
        IAccessService access,
        IServerStore servers,
        IAlertStore alerts,
        AlertConfigProvider config,
        CancellationToken cancellationToken)
    {
        var userId = principal.RequireUserId();
        if (!await access.IsOwnerAsync(userId, id, cancellationToken))
        {
            return Validation.Forbidden("Only the owner can change a server's alert settings");
        }

        Dictionary<string, RuleSettingDocument>? overrides = null;
        var clearOverrides = request.UseAccountDefaults == true;
        if (!clearOverrides && request.Rules is not null)
        {
            overrides = ValidateRules(request.Rules, out var errors);
            if (errors.Count > 0)
            {
                return Validation.ValidationProblem(errors);
            }
        }

        var doc = await servers.UpdateAlertSettingsAsync(id, clearOverrides ? new Dictionary<string, RuleSettingDocument>() : overrides, request.Muted, request.ClearSilence == true, cancellationToken);
        if (doc is null)
        {
            return Validation.NotFound("Server not found");
        }

        config.Invalidate(id);
        var settings = await alerts.GetSettingsAsync(userId, cancellationToken);
        return Results.Ok(ToServerDto(doc, settings));
    }

    // ---- push subscriptions ------------------------------------------------------------------------

    private static async Task<IResult> AddPushSubscriptionAsync(
        PushSubscriptionRequest request,
        ClaimsPrincipal principal,
        IAlertStore alerts,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var endpoint = request.Endpoint?.Trim();
        var p256dh = request.Keys?.P256dh?.Trim();
        var auth = request.Keys?.Auth?.Trim();
        if (string.IsNullOrEmpty(endpoint) || endpoint.Length > 2048 || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https")
        {
            return Validation.ValidationProblem("endpoint", "endpoint must be an https URL.");
        }

        if (string.IsNullOrEmpty(p256dh) || string.IsNullOrEmpty(auth) || p256dh.Length > 200 || auth.Length > 100)
        {
            return Validation.ValidationProblem("keys", "keys.p256dh and keys.auth are required.");
        }

        var device = (request.Device ?? "").Trim();
        var subscription = new PushSubscriptionDocument
        {
            UserId = principal.RequireUserId(),
            Endpoint = endpoint,
            P256dh = p256dh,
            Auth = auth,
            Device = device.Length > 80 ? device[..80] : device,
            CreatedAt = clock.GetUtcNow().UtcDateTime,
        };
        await alerts.UpsertSubscriptionAsync(subscription, cancellationToken);
        return Results.Created("/api/push-subscriptions", new PushDeviceDto(subscription.Id, subscription.Device, new DateTimeOffset(subscription.CreatedAt, TimeSpan.Zero)));
    }

    private static async Task<IResult> DeletePushSubscriptionAsync(
        [FromBody] DeletePushSubscriptionRequest request,
        ClaimsPrincipal principal,
        IAlertStore alerts,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Endpoint))
        {
            return Validation.ValidationProblem("endpoint", "endpoint is required.");
        }

        await alerts.DeleteSubscriptionAsync(principal.RequireUserId(), request.Endpoint.Trim(), cancellationToken);
        return Results.NoContent();
    }

    // ---- helpers -----------------------------------------------------------------------------------

    private static Dictionary<string, RuleSettingDocument> ValidateRules(Dictionary<string, RuleSettingDto>? rules, out Dictionary<string, string[]> errors)
    {
        errors = new Dictionary<string, string[]>();
        var result = new Dictionary<string, RuleSettingDocument>(StringComparer.Ordinal);
        foreach (var (id, setting) in rules ?? [])
        {
            if (!AlertRules.ById.TryGetValue(id, out var definition))
            {
                errors[id] = ["Unknown rule."];
                continue;
            }

            var doc = new RuleSettingDocument { Enabled = setting.Enabled };
            if (setting.Threshold is { } threshold)
            {
                if (definition.Threshold is null || !AlertRules.IsValidThreshold(definition, threshold))
                {
                    errors[id] = [definition.ThresholdUnit == ThresholdUnits.Percent ? "Threshold must be 1–100 %." : definition.ThresholdUnit == ThresholdUnits.Count ? "Threshold must be a whole number of 1–1000." : "This rule has no threshold."];
                    continue;
                }

                doc.Threshold = threshold;
            }

            if (setting.DurationSec is { } duration)
            {
                if (!AlertRules.IsValidDuration(definition, duration))
                {
                    errors[id] = [definition.HasDuration ? "Duration must be 30 s – 24 h." : "This rule has no duration."];
                    continue;
                }

                doc.DurationSec = duration;
            }

            if (!doc.IsEmpty)
            {
                result[id] = doc;
            }
        }

        return result;
    }

    private static bool IsTime(string? value) =>
        value is { Length: 5 } && TimeOnly.TryParseExact(value, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    private static AlertSettingsDto ToDto(AlertSettingsDocument settings, IReadOnlyList<PushSubscriptionDocument> devices, string email, bool pushConfigured)
    {
        var rules = AlertRules.All.Select(definition =>
        {
            var effective = EffectiveRule.Default(definition).With(settings.Rules.GetValueOrDefault(definition.Id));
            return new RuleInfoDto(definition.Id, definition.Severity, definition.ThresholdUnit, definition.Threshold, definition.DurationSec, effective.Enabled, effective.Threshold, effective.DurationSec, false);
        }).ToList();
        return new AlertSettingsDto(
            rules,
            new ChannelsDto(settings.Channels.Push, settings.Channels.Email, settings.Channels.WebhookUrl, settings.Channels.WebhookSecret, pushConfigured),
            new DigestDto(settings.Digest.Enabled, settings.Digest.Time),
            devices.OrderBy(d => d.CreatedAt).Select(d => new PushDeviceDto(d.Id, d.Device, new DateTimeOffset(DateTime.SpecifyKind(d.CreatedAt, DateTimeKind.Utc)))).ToList(),
            email);
    }

    private static ServerAlertSettingsDto ToServerDto(ServerDocument doc, AlertSettingsDocument? account)
    {
        var overrides = doc.AlertOverrides ?? new Dictionary<string, RuleSettingDocument>();
        var rules = AlertRules.All.Select(definition =>
        {
            var accountRule = EffectiveRule.Default(definition).With(account?.Rules.GetValueOrDefault(definition.Id));
            var over = overrides.GetValueOrDefault(definition.Id);
            var effective = accountRule.With(over);
            return new RuleInfoDto(definition.Id, definition.Severity, definition.ThresholdUnit, accountRule.Threshold, accountRule.DurationSec, effective.Enabled, effective.Threshold, effective.DurationSec, over is { IsEmpty: false });
        }).ToList();
        return new ServerAlertSettingsDto(
            doc.Id,
            doc.Name,
            overrides.Count == 0,
            doc.AlertsMuted,
            doc.SilencedUntil is { } until ? new DateTimeOffset(DateTime.SpecifyKind(until, DateTimeKind.Utc)) : null,
            rules);
    }

    private static string Name(string serverId, IReadOnlyDictionary<string, ServerDocument> docs, AgentRegistry registry)
    {
        if (docs.TryGetValue(serverId, out var doc))
        {
            return doc.Name;
        }

        return registry.TryGet(serverId, out var session) ? session.Name : serverId;
    }

    private static bool IsSilenced(AlertDocument alert, IReadOnlyDictionary<string, ServerDocument> docs, DateTimeOffset now)
    {
        if (alert.State != AlertStates.Firing || !docs.TryGetValue(alert.ServerId, out var doc))
        {
            return false;
        }

        return doc.AlertsMuted || doc.SilencedUntil is { } until && new DateTimeOffset(DateTime.SpecifyKind(until, DateTimeKind.Utc)) > now;
    }
}
