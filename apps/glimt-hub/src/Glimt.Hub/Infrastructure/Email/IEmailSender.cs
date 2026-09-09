namespace Glimt.Hub.Infrastructure.Email;

/// <summary>One outgoing e-mail. Text and HTML are both provided; the sender decides what the provider needs.</summary>
public sealed record EmailMessage(string To, string Subject, string Text, string Html);

/// <summary>
/// E-mail goes through the owner's own service appmail (Brevo behind it), never MailKit/SMTP (IMPLEMENTERINGSPLAN 1.2).
/// Implementations: <see cref="ConsoleEmailSender"/> in development, <see cref="AppmailEmailSender"/> when GLIMT_APPMAIL_URL is set.
/// Senders never throw into the caller's request path: they return false and log when delivery fails.
/// </summary>
public interface IEmailSender
{
    Task<bool> SendAsync(EmailMessage message, CancellationToken cancellationToken);
}

/// <summary>Logs the mail (including links) so flows can be tested without a mail service.</summary>
public sealed class ConsoleEmailSender(ILogger<ConsoleEmailSender> logger) : IEmailSender
{
    public Task<bool> SendAsync(EmailMessage message, CancellationToken cancellationToken)
    {
        logger.LogInformation("e-mail to {To}: {Subject}\n{Text}", message.To, message.Subject, message.Text);
        return Task.FromResult(true);
    }
}
