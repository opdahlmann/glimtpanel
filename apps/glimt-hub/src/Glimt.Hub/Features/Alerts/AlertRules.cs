namespace Glimt.Hub.Features.Alerts;

/// <summary>The seven rules (FUNKSJONSBESKRIVELSE 10.1). Ids are the dictionary keys in the web app (`r_server_down` …).</summary>
public static class AlertRuleIds
{
    public const string ServerDown = "server_down";
    public const string DiskFull = "disk_full";
    public const string MemPressure = "mem_pressure";
    public const string CpuSat = "cpu_sat";
    public const string ContRestart = "cont_restart";
    public const string SvcFailed = "svc_failed";
    public const string Reboot = "reboot";
}

public static class AlertSeverities
{
    public const string Critical = "critical";
    public const string Warning = "warning";
    public const string Info = "info";

    /// <summary>critical &gt; warning &gt; info, for the worst severity on a card.</summary>
    public static int Rank(string? severity) => severity switch
    {
        Critical => 3,
        Warning => 2,
        Info => 1,
        _ => 0,
    };
}

public static class AlertStates
{
    public const string Firing = "firing";
    public const string Resolved = "resolved";
}

public static class AlertEventKinds
{
    public const string Fired = "fired";
    public const string Resolved = "resolved";
    public const string Reminder = "reminder";
}

/// <summary>What a threshold means for a rule, so the settings screen can show the right unit.</summary>
public static class ThresholdUnits
{
    public const string Percent = "percent";
    public const string Seconds = "seconds";
    public const string Count = "count";
    public const string None = "none";
}

/// <summary>
/// A rule with its defaults (IMPLEMENTERINGSPLAN 4.6, step 7.1). `Threshold` is a percentage (disk, memory, cpu)
/// or a count (container restarts); `DurationSec` is how long the condition must hold before the alert fires, or,
/// when <see cref="DurationIsWindow"/>, the window the count is measured in (server_down: not seen for that long;
/// cont_restart: restarts within that long).
/// </summary>
public sealed record AlertRuleDefinition(string Id, string Severity, double? Threshold, int? DurationSec, string ThresholdUnit, bool Instanced, bool DurationIsWindow = false)
{
    /// <summary>Snapshots arrive every 30 s; durations are counted on snapshots, so they are rounded down to whole snapshots.</summary>
    public bool HasDuration => DurationSec is > 0;
}

public static class AlertRules
{
    public static readonly AlertRuleDefinition ServerDown = new(AlertRuleIds.ServerDown, AlertSeverities.Critical, null, 120, ThresholdUnits.Seconds, false, DurationIsWindow: true);
    public static readonly AlertRuleDefinition DiskFull = new(AlertRuleIds.DiskFull, AlertSeverities.Critical, 90, null, ThresholdUnits.Percent, true);
    public static readonly AlertRuleDefinition MemPressure = new(AlertRuleIds.MemPressure, AlertSeverities.Warning, 95, 300, ThresholdUnits.Percent, false);
    public static readonly AlertRuleDefinition CpuSat = new(AlertRuleIds.CpuSat, AlertSeverities.Warning, 95, 900, ThresholdUnits.Percent, false);
    public static readonly AlertRuleDefinition ContRestart = new(AlertRuleIds.ContRestart, AlertSeverities.Warning, 3, 600, ThresholdUnits.Count, true, DurationIsWindow: true);
    public static readonly AlertRuleDefinition SvcFailed = new(AlertRuleIds.SvcFailed, AlertSeverities.Warning, null, null, ThresholdUnits.None, true);
    public static readonly AlertRuleDefinition Reboot = new(AlertRuleIds.Reboot, AlertSeverities.Info, null, null, ThresholdUnits.None, false);

    /// <summary>In the order the web app lists them.</summary>
    public static readonly IReadOnlyList<AlertRuleDefinition> All = [ServerDown, DiskFull, MemPressure, CpuSat, ContRestart, SvcFailed, Reboot];

    public static readonly IReadOnlyDictionary<string, AlertRuleDefinition> ById = All.ToDictionary(r => r.Id, StringComparer.Ordinal);

    public static bool IsRule(string? id) => id is not null && ById.ContainsKey(id);

    /// <summary>Rules whose e-mail cannot be turned off (FUNKSJONSBESKRIVELSE 10.3).</summary>
    public static bool AlwaysEmailed(string rule) => rule is AlertRuleIds.ServerDown or AlertRuleIds.DiskFull;

    /// <summary>Threshold bounds per unit, used by the settings endpoints.</summary>
    public static bool IsValidThreshold(AlertRuleDefinition rule, double value) => rule.ThresholdUnit switch
    {
        ThresholdUnits.Percent => value is >= 1 and <= 100,
        ThresholdUnits.Count => value is >= 1 and <= 1000 && Math.Abs(value - Math.Round(value)) < 0.0001,
        _ => false,
    };

    public static bool IsValidDuration(AlertRuleDefinition rule, int seconds) => rule.HasDuration && seconds is >= 30 and <= 86_400;
}

/// <summary>A rule after account settings and server overrides are applied.</summary>
public sealed record EffectiveRule(AlertRuleDefinition Definition, bool Enabled, double? Threshold, int? DurationSec)
{
    public string Id => Definition.Id;

    public string Severity => Definition.Severity;

    public static EffectiveRule Default(AlertRuleDefinition definition) => new(definition, true, definition.Threshold, definition.DurationSec);

    /// <summary>Lays a setting (account or server) over this rule; nulls keep the current value.</summary>
    public EffectiveRule With(RuleSettingDocument? setting)
    {
        if (setting is null)
        {
            return this;
        }

        return this with
        {
            Enabled = setting.Enabled ?? Enabled,
            Threshold = Definition.Threshold is null ? null : setting.Threshold ?? Threshold,
            DurationSec = Definition.DurationSec is null ? null : setting.DurationSec ?? DurationSec,
        };
    }
}
