namespace Glimt.Hub.Features.Alerts;

/// <summary>One row on the alerts page and the payload of the SignalR `Alert` event. Serialized camelCase.</summary>
public sealed record AlertDto(
    string Id,
    string ServerId,
    string ServerName,
    string Rule,
    string Key,
    string Severity,
    string State,
    string Detail,
    DateTimeOffset FiredAt,
    DateTimeOffset? ResolvedAt,
    DateTimeOffset? LastReminderAt,
    bool Silenced,
    IReadOnlyList<string> NotifiedVia)
{
    public static AlertDto From(AlertDocument a, string serverName, bool silenced) => new(
        a.Id,
        a.ServerId,
        serverName,
        a.Rule,
        a.Key,
        a.Severity,
        a.State,
        a.Detail,
        Utc(a.FiredAt),
        a.ResolvedAt is { } r ? Utc(r) : null,
        a.LastReminderAt is { } l ? Utc(l) : null,
        silenced,
        a.NotifiedVia.ToArray());

    private static DateTimeOffset Utc(DateTime value) => new(DateTime.SpecifyKind(value, DateTimeKind.Utc));
}

/// <summary>Hub → client `Alert(event)`: fired, resolved or reminder, plus the server's active count after the change.</summary>
public sealed record AlertEventDto(string Kind, AlertDto Alert, int ActiveOnServer, string? WorstSeverity);

/// <summary>GET /api/alerts: the rows (newest first, at most 200) and the counts for "5 active · 3 resolved".</summary>
public sealed record AlertListResponse(IReadOnlyList<AlertDto> Alerts, int Active, int Resolved);

public sealed record SilenceRequest(string? ServerId, string? Until);

public sealed record SilenceResponse(string ServerId, DateTimeOffset? SilencedUntil);

/// <summary>One rule with its defaults and current values; `Overridden` marks a server-level override.</summary>
public sealed record RuleInfoDto(
    string Id,
    string Severity,
    string ThresholdUnit,
    double? DefaultThreshold,
    int? DefaultDurationSec,
    bool Enabled,
    double? Threshold,
    int? DurationSec,
    bool Overridden);

public sealed record RuleSettingDto(bool? Enabled, double? Threshold, int? DurationSec);

public sealed record ChannelsDto(bool Push, bool Email, string? WebhookUrl, string WebhookSecret, bool PushConfigured);

public sealed record DigestDto(bool Enabled, string Time);

public sealed record PushDeviceDto(string Id, string Device, DateTimeOffset CreatedAt);

/// <summary>GET /api/alert-settings (the account, screen 10).</summary>
public sealed record AlertSettingsDto(IReadOnlyList<RuleInfoDto> Rules, ChannelsDto Channels, DigestDto Digest, IReadOnlyList<PushDeviceDto> PushDevices, string Email);

public sealed record PutAlertSettingsRequest(Dictionary<string, RuleSettingDto>? Rules);

public sealed record PutChannelsRequest(bool? Push, bool? Email, string? WebhookUrl, DigestDto? Digest, bool? RotateWebhookSecret);

/// <summary>GET/PUT /api/servers/{id}/alert-settings (screen 10 with ?server=).</summary>
public sealed record ServerAlertSettingsDto(string ServerId, string ServerName, bool UseAccountDefaults, bool Muted, DateTimeOffset? SilencedUntil, IReadOnlyList<RuleInfoDto> Rules);

public sealed record PutServerAlertSettingsRequest(bool? UseAccountDefaults, bool? Muted, bool? ClearSilence, Dictionary<string, RuleSettingDto>? Rules);

public sealed record PushKeysRequest(string? P256dh, string? Auth);

public sealed record PushSubscriptionRequest(string? Endpoint, PushKeysRequest? Keys, string? Device);

public sealed record DeletePushSubscriptionRequest(string? Endpoint);

public sealed record WebhookTestResponse(bool Ok, int? Status);
