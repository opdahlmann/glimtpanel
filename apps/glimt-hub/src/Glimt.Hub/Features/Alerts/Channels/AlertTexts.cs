using Glimt.Hub.Infrastructure.Email;

namespace Glimt.Hub.Features.Alerts.Channels;

/// <summary>Rule names and links for push, e-mail and webhook, in English and Norwegian (the same words as the web dictionary).</summary>
public static class AlertTexts
{
    private static readonly Dictionary<string, (string En, string No)> RuleNames = new(StringComparer.Ordinal)
    {
        [AlertRuleIds.ServerDown] = ("Server down", "Server nede"),
        [AlertRuleIds.DiskFull] = ("Disk almost full", "Disk nesten full"),
        [AlertRuleIds.MemPressure] = ("Memory pressure", "Minne presset"),
        [AlertRuleIds.CpuSat] = ("CPU saturated", "Prosessor mettet"),
        [AlertRuleIds.ContRestart] = ("Container stopped or restart loop", "Container stoppet eller omstartsløkke"),
        [AlertRuleIds.SvcFailed] = ("Service failed", "Tjeneste feilet"),
        [AlertRuleIds.Reboot] = ("Reboot required", "Omstart kreves"),
    };

    public static string RuleName(string rule, string? language)
    {
        if (!RuleNames.TryGetValue(rule, out var names))
        {
            return rule;
        }

        return EmailTemplates.Language(language) == EmailTemplates.Norwegian ? names.No : names.En;
    }

    /// <summary>"web-02 · Disk almost full", the title of a push and the subject of an e-mail.</summary>
    public static string Title(AlertEvent e, string? language)
    {
        var name = RuleName(e.Alert.Rule, language);
        return e.Kind switch
        {
            AlertEventKinds.Resolved => $"{e.ServerName} · {name} · {(EmailTemplates.Language(language) == EmailTemplates.Norwegian ? "løst" : "resolved")}",
            AlertEventKinds.Reminder => $"{e.ServerName} · {name} · {(EmailTemplates.Language(language) == EmailTemplates.Norwegian ? "står fortsatt" : "still firing")}",
            _ => $"{e.ServerName} · {name}",
        };
    }

    /// <summary>The path in the web app a notification opens (IMPLEMENTERINGSPLAN step 7.2).</summary>
    public static string Path(AlertDocument alert) => alert.Rule switch
    {
        AlertRuleIds.DiskFull => $"/servers/{alert.ServerId}#disk",
        AlertRuleIds.MemPressure => $"/servers/{alert.ServerId}#mem",
        AlertRuleIds.CpuSat => $"/servers/{alert.ServerId}#cpu",
        AlertRuleIds.ContRestart => $"/servers/{alert.ServerId}#cont",
        AlertRuleIds.Reboot => $"/servers/{alert.ServerId}#maint",
        AlertRuleIds.SvcFailed => $"/logs?server={Uri.EscapeDataString(alert.ServerId)}&source=journal&unit={Uri.EscapeDataString(alert.Key)}",
        _ => $"/servers/{alert.ServerId}",
    };

    public static string Tag(AlertDocument alert) => $"{alert.ServerId}:{alert.Rule}";

    public static string Topic(AlertDocument alert) => $"{alert.ServerId}-{alert.Rule}";
}
