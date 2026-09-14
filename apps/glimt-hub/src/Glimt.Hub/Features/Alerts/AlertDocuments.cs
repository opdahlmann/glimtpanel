using MongoDB.Bson.Serialization.Attributes;

namespace Glimt.Hub.Features.Alerts;

/// <summary>Collection `alerts` (IMPLEMENTERINGSPLAN 4.4). One document per fired alert; resolved documents stay for the list.</summary>
public sealed class AlertDocument
{
    public const string Collection = "alerts";

    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string ServerId { get; set; } = "";

    /// <summary>The owner at the time the alert fired (dev servers: the dev user). Export and delete-account use it.</summary>
    public string? OwnerId { get; set; }

    public string Rule { get; set; } = "";

    /// <summary>Instance within the rule: mount path, container name or unit name. Empty for host-wide rules.</summary>
    public string Key { get; set; } = "";

    public string Severity { get; set; } = AlertSeverities.Warning;
    public string State { get; set; } = AlertStates.Firing;

    /// <summary>Human detail such as "/ · 92 %" or "acme-worker · 7 restarts / 10 min".</summary>
    public string Detail { get; set; } = "";

    public DateTime FiredAt { get; set; }
    public DateTime? ResolvedAt { get; set; }
    public DateTime? LastReminderAt { get; set; }

    /// <summary>Channels that got the fired message: push, email, webhook.</summary>
    public List<string> NotifiedVia { get; set; } = [];
}

/// <summary>enabled / threshold / durationSec for one rule; null means "not overridden" (IMPLEMENTERINGSPLAN 4.4).</summary>
public sealed class RuleSettingDocument
{
    public bool? Enabled { get; set; }
    public double? Threshold { get; set; }
    public int? DurationSec { get; set; }

    public bool IsEmpty => Enabled is null && Threshold is null && DurationSec is null;
}

/// <summary>Collection `alertSettings`: one per user (IMPLEMENTERINGSPLAN 4.4). Missing document = defaults.</summary>
public sealed class AlertSettingsDocument
{
    public const string Collection = "alertSettings";
    public const string DefaultDigestTime = "08:00";

    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = "";
    public Dictionary<string, RuleSettingDocument> Rules { get; set; } = new(StringComparer.Ordinal);
    public ChannelsDocument Channels { get; set; } = new();
    public DigestDocument Digest { get; set; } = new();

    /// <summary>Local date (yyyy-MM-dd in the user's zone) of the last digest, so it goes out once a day.</summary>
    public string? LastDigestDate { get; set; }

    public static AlertSettingsDocument Defaults(string userId) => new() { UserId = userId };
}

public sealed class ChannelsDocument
{
    public bool Push { get; set; } = true;

    /// <summary>E-mail for the rules that can be turned off; server_down and disk_full always go to the owner.</summary>
    public bool Email { get; set; } = true;

    public string? WebhookUrl { get; set; }

    /// <summary>Shared secret for X-Glimtpanel-Signature (HMAC-SHA256). Created with the settings document.</summary>
    public string WebhookSecret { get; set; } = NewSecret();

    public static string NewSecret() => "whs_" + Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24));
}

public sealed class DigestDocument
{
    public bool Enabled { get; set; } = true;

    /// <summary>"HH:mm" in the user's time zone.</summary>
    public string Time { get; set; } = AlertSettingsDocument.DefaultDigestTime;
}

/// <summary>Collection `pushSubscriptions` (IMPLEMENTERINGSPLAN 4.4): one per browser/device, unique on endpoint.</summary>
public sealed class PushSubscriptionDocument
{
    public const string Collection = "pushSubscriptions";

    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = "";
    public string Endpoint { get; set; } = "";
    public string P256dh { get; set; } = "";
    public string Auth { get; set; } = "";

    /// <summary>Label such as "iPhone" or "MacBook · Chrome", from the browser at subscription time.</summary>
    public string Device { get; set; } = "";

    public DateTime CreatedAt { get; set; }
    public DateTime? FailedAt { get; set; }
}
