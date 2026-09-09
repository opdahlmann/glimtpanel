using System.Net;
using System.Text;

namespace Glimt.Hub.Infrastructure.Email;

/// <summary>
/// Subject, plain text and minimal HTML for every mail the hub sends, in English and Norwegian by the
/// recipient's language ("en" or "no"; anything else falls back to English). Plain string building, no template engine.
/// </summary>
public static class EmailTemplates
{
    public const string English = "en";
    public const string Norwegian = "no";

    /// <summary>Normalises a stored language value to "en" or "no".</summary>
    public static string Language(string? language) =>
        string.Equals(language, Norwegian, StringComparison.OrdinalIgnoreCase) ? Norwegian : English;

    public static EmailMessage Confirm(string to, string? language, string link) =>
        Language(language) == Norwegian
            ? Build(to, "Bekreft e-postadressen din hos Glimtpanel",
                "Hei!",
                "Takk for at du registrerte deg hos Glimtpanel. Bekreft e-postadressen din ved å åpne lenken under. Lenken virker i 24 timer.",
                link, "Bekreft e-post",
                "Har du ikke registrert deg hos Glimtpanel, kan du se bort fra denne e-posten.")
            : Build(to, "Confirm your e-mail address for Glimtpanel",
                "Hello!",
                "Thanks for signing up for Glimtpanel. Confirm your e-mail address by opening the link below. The link works for 24 hours.",
                link, "Confirm e-mail",
                "If you did not sign up for Glimtpanel, you can ignore this e-mail.");

    public static EmailMessage Reset(string to, string? language, string link) =>
        Language(language) == Norwegian
            ? Build(to, "Tilbakestill passordet ditt hos Glimtpanel",
                "Hei!",
                "Noen ba om å tilbakestille passordet for Glimtpanel-kontoen din. Åpne lenken under for å velge et nytt passord. Lenken virker i 1 time.",
                link, "Velg nytt passord",
                "Var det ikke deg, kan du se bort fra denne e-posten. Passordet ditt er ikke endret.")
            : Build(to, "Reset your Glimtpanel password",
                "Hello!",
                "Someone asked to reset the password for your Glimtpanel account. Open the link below to choose a new password. The link works for 1 hour.",
                link, "Choose a new password",
                "If this was not you, you can ignore this e-mail. Your password has not been changed.");

    /// <summary>Invitation to someone without an account: register/accept through the link.</summary>
    public static EmailMessage Invite(string to, string? language, string ownerName, string link) =>
        Language(language) == Norwegian
            ? Build(to, $"{ownerName} har gitt deg lesetilgang i Glimtpanel",
                "Hei!",
                $"{ownerName} vil dele servere med deg i Glimtpanel. Åpne lenken under for å opprette en konto (eller logge inn) og godta tilgangen.",
                link, "Godta tilgang",
                "Kjenner du ikke avsenderen, kan du se bort fra denne e-posten.")
            : Build(to, $"{ownerName} gave you read access in Glimtpanel",
                "Hello!",
                $"{ownerName} wants to share servers with you in Glimtpanel. Open the link below to create an account (or log in) and accept the access.",
                link, "Accept access",
                "If you do not know the sender, you can ignore this e-mail.");

    /// <summary>Notice to an existing user: the grant is already active.</summary>
    public static EmailMessage AccessGranted(string to, string? language, string ownerName, string link) =>
        Language(language) == Norwegian
            ? Build(to, $"{ownerName} har gitt deg lesetilgang i Glimtpanel",
                "Hei!",
                $"{ownerName} har gitt deg lesetilgang til sine servere i Glimtpanel. Du ser dem i oversikten neste gang du logger inn.",
                link, "Åpne Glimtpanel",
                null)
            : Build(to, $"{ownerName} gave you read access in Glimtpanel",
                "Hello!",
                $"{ownerName} gave you read access to their servers in Glimtpanel. You will see them in the overview the next time you log in.",
                link, "Open Glimtpanel",
                null);

    private static EmailMessage Build(string to, string subject, string greeting, string body, string link, string linkLabel, string? footer)
    {
        var text = new StringBuilder()
            .Append(greeting).Append("\n\n")
            .Append(body).Append("\n\n")
            .Append(link).Append('\n');
        if (footer is not null)
        {
            text.Append('\n').Append(footer).Append('\n');
        }

        text.Append("\n— Glimtpanel\n");

        var html = new StringBuilder()
            .Append("<!doctype html><html><body style=\"font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a\">")
            .Append("<p>").Append(WebUtility.HtmlEncode(greeting)).Append("</p>")
            .Append("<p>").Append(WebUtility.HtmlEncode(body)).Append("</p>")
            .Append("<p><a href=\"").Append(WebUtility.HtmlEncode(link)).Append("\" style=\"display:inline-block;padding:10px 16px;background:#1f6feb;color:#fff;text-decoration:none;border-radius:6px\">")
            .Append(WebUtility.HtmlEncode(linkLabel)).Append("</a></p>")
            .Append("<p style=\"font-size:13px;color:#555\">").Append(WebUtility.HtmlEncode(link)).Append("</p>");
        if (footer is not null)
        {
            html.Append("<p style=\"font-size:13px;color:#555\">").Append(WebUtility.HtmlEncode(footer)).Append("</p>");
        }

        html.Append("<p>— Glimtpanel</p></body></html>");
        return new EmailMessage(to, subject, text.ToString(), html.ToString());
    }
}
