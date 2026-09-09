using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace Glimt.Hub.Infrastructure.Email;

/// <summary>
/// Sends mail through the owner's appmail service (IMPLEMENTERINGSPLAN 1.2, 1.4). The contract is not confirmed yet;
/// this adapter documents the assumption it is written against:
/// <c>POST {GLIMT_APPMAIL_URL}</c> with JSON <c>{ to, from, subject, text, html }</c>, header
/// <c>Authorization: Bearer {GLIMT_APPMAIL_API_KEY}</c>, any 2xx means accepted. 10 s timeout.
/// Failures are logged as errors and reported as <c>false</c>; nothing is thrown into the request path.
/// </summary>
public sealed class AppmailEmailSender(IHttpClientFactory httpClientFactory, GlimtOptions options, ILogger<AppmailEmailSender> logger) : IEmailSender
{
    public const string ClientName = "appmail";
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    // TODO(appmail): confirm contract (endpoint, field names, whether appmail has its own templates) with the owner.
    internal sealed record Payload(
        [property: JsonPropertyName("to")] string To,
        [property: JsonPropertyName("from")] string? From,
        [property: JsonPropertyName("subject")] string Subject,
        [property: JsonPropertyName("text")] string Text,
        [property: JsonPropertyName("html")] string Html);

    public async Task<bool> SendAsync(EmailMessage message, CancellationToken cancellationToken)
    {
        var url = options.AppmailUrl;
        if (string.IsNullOrWhiteSpace(url))
        {
            logger.LogError("e-mail to {To} not sent: GLIMT_APPMAIL_URL is empty", message.To);
            return false;
        }

        try
        {
            using var client = httpClientFactory.CreateClient(ClientName);
            using var request = new HttpRequestMessage(HttpMethod.Post, url);
            if (!string.IsNullOrWhiteSpace(options.AppmailApiKey))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.AppmailApiKey);
            }

            request.Content = JsonContent.Create(new Payload(message.To, options.MailFrom, message.Subject, message.Text, message.Html));
            using var response = await client.SendAsync(request, cancellationToken);
            if (response.IsSuccessStatusCode)
            {
                logger.LogInformation("e-mail to {To} accepted by appmail: {Subject}", message.To, message.Subject);
                return true;
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            logger.LogError("appmail rejected e-mail to {To} ({Subject}): {Status} {Body}", message.To, message.Subject, (int)response.StatusCode, Trim(body));
            return false;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            logger.LogError("appmail request for e-mail to {To} ({Subject}) failed: {Error}", message.To, message.Subject, ex.Message);
            return false;
        }
    }

    private static string Trim(string body) => body.Length <= 300 ? body : body[..300] + "…";
}
