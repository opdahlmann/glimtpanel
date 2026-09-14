using System.Globalization;
using System.Net;
using System.Text;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Infrastructure.Email;

namespace Glimt.Hub.Features.Alerts.Channels;

/// <summary>
/// E-mail to the owner through <see cref="IEmailSender"/> (appmail today, Brevo behind it; the adapter is the only
/// thing that changes when the owner wires the Brevo API). Always for server_down and disk_full, otherwise when the
/// owner has e-mail on (FUNKSJONSBESKRIVELSE 10.3). One template for fired, one for resolved, in the owner's language.
/// </summary>
public sealed class EmailChannel(IEmailSender mail, AuthSessions sessions) : IChannel
{
    public string Name => ChannelNames.Email;

    public async Task<bool> SendAsync(AlertNotification notification, CancellationToken cancellationToken)
    {
        if (!notification.IsOwner)
        {
            return false;
        }

        var e = notification.Event;
        if (!AlertRules.AlwaysEmailed(e.Alert.Rule) && !notification.Settings.Channels.Email)
        {
            return false;
        }

        var link = sessions.WebLink(AlertTexts.Path(e.Alert));
        var message = AlertEmailTemplates.Alert(notification.User.Email, notification.User.Language, notification.User.Timezone, e, link);
        return await mail.SendAsync(message, cancellationToken);
    }
}

/// <summary>Subject, text and HTML for alert mails and the daily digest (English and Norwegian).</summary>
public static class AlertEmailTemplates
{
    public static EmailMessage Alert(string to, string? language, string? timezone, AlertEvent e, string link)
    {
        var no = EmailTemplates.Language(language) == EmailTemplates.Norwegian;
        var title = AlertTexts.Title(e, language);
        var at = Local(e.Kind == AlertEventKinds.Resolved ? e.Alert.ResolvedAt ?? e.Alert.FiredAt : e.Alert.FiredAt, timezone);
        var subject = "[Glimtpanel] " + title;
        var body = e.Kind switch
        {
            AlertEventKinds.Resolved => no
                ? $"Varselet «{AlertTexts.RuleName(e.Alert.Rule, language)}» på {e.ServerName} er løst ({at})."
                : $"The alert “{AlertTexts.RuleName(e.Alert.Rule, language)}” on {e.ServerName} is resolved ({at}).",
            AlertEventKinds.Reminder => no
                ? $"Påminnelse: «{AlertTexts.RuleName(e.Alert.Rule, language)}» på {e.ServerName} står fortsatt, utløst {at}."
                : $"Reminder: “{AlertTexts.RuleName(e.Alert.Rule, language)}” on {e.ServerName} is still firing, since {at}.",
            _ => no
                ? $"{e.ServerName}: {AlertTexts.RuleName(e.Alert.Rule, language)} ({at})."
                : $"{e.ServerName}: {AlertTexts.RuleName(e.Alert.Rule, language)} ({at}).",
        };
        var lines = new List<string> { body };
        if (e.Alert.Detail.Length > 0)
        {
            lines.Add(e.Alert.Detail);
        }

        return Build(to, subject, lines, link, no ? "Åpne i Glimtpanel" : "Open in Glimtpanel", no
            ? "Du får denne e-posten fordi du eier serveren. Kanaler kan endres under Innstillinger › Varsler."
            : "You get this e-mail because you own the server. Channels can be changed under Settings › Alerts.");
    }

    /// <summary>The daily summary: info alerts from the last 24 hours and everything still firing.</summary>
    public static EmailMessage Digest(string to, string? language, string? timezone, IReadOnlyList<(AlertDocument Alert, string ServerName)> info, IReadOnlyList<(AlertDocument Alert, string ServerName)> firing, string link)
    {
        var no = EmailTemplates.Language(language) == EmailTemplates.Norwegian;
        var lines = new List<string>();
        if (firing.Count > 0)
        {
            lines.Add(no ? $"Står fortsatt ({firing.Count}):" : $"Still firing ({firing.Count}):");
            lines.AddRange(firing.Select(f => $"• {f.ServerName} · {AlertTexts.RuleName(f.Alert.Rule, language)}{Detail(f.Alert)} · {Local(f.Alert.FiredAt, timezone)}"));
        }

        if (info.Count > 0)
        {
            lines.Add(no ? $"Informasjon siste døgn ({info.Count}):" : $"Info in the last 24 hours ({info.Count}):");
            lines.AddRange(info.Select(i => $"• {i.ServerName} · {AlertTexts.RuleName(i.Alert.Rule, language)}{Detail(i.Alert)} · {Local(i.Alert.FiredAt, timezone)}"));
        }

        var subject = no ? "[Glimtpanel] Daglig oppsummering" : "[Glimtpanel] Daily summary";
        return Build(to, subject, lines, link, no ? "Åpne varslene" : "Open alerts", no
            ? "Oppsummeringen kan slås av under Innstillinger › Varsler."
            : "The summary can be turned off under Settings › Alerts.");
    }

    private static string Detail(AlertDocument alert) => alert.Detail.Length == 0 ? "" : " · " + alert.Detail;

    /// <summary>"Sep 7 14:20" in the recipient's zone (UTC when the zone is unknown).</summary>
    public static string Local(DateTime utc, string? timezone)
    {
        var at = new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc));
        if (!string.IsNullOrWhiteSpace(timezone) && TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out var zone))
        {
            at = TimeZoneInfo.ConvertTime(at, zone);
        }

        return at.ToString("MMM d HH:mm", CultureInfo.InvariantCulture);
    }

    private static EmailMessage Build(string to, string subject, IReadOnlyList<string> lines, string link, string linkLabel, string footer)
    {
        var text = new StringBuilder();
        foreach (var line in lines)
        {
            text.Append(line).Append('\n');
        }

        text.Append('\n').Append(link).Append("\n\n").Append(footer).Append("\n\n— Glimtpanel\n");

        var html = new StringBuilder()
            .Append("<!doctype html><html><body style=\"font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a\">");
        foreach (var line in lines)
        {
            html.Append("<p style=\"margin:0 0 6px\">").Append(WebUtility.HtmlEncode(line)).Append("</p>");
        }

        html.Append("<p><a href=\"").Append(WebUtility.HtmlEncode(link)).Append("\" style=\"display:inline-block;margin-top:10px;padding:10px 16px;background:#1f6feb;color:#fff;text-decoration:none;border-radius:6px\">")
            .Append(WebUtility.HtmlEncode(linkLabel)).Append("</a></p>")
            .Append("<p style=\"font-size:13px;color:#555\">").Append(WebUtility.HtmlEncode(footer)).Append("</p>")
            .Append("<p>— Glimtpanel</p></body></html>");
        return new EmailMessage(to, subject, text.ToString(), html.ToString());
    }
}
