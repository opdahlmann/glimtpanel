using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Glimt.Hub.Features.Auth;

namespace Glimt.Hub.Features.Alerts.Channels;

/// <summary>The JSON a webhook receives (IMPLEMENTERINGSPLAN 4.6): { event, server, rule, severity, detail, at, url }.</summary>
public sealed record WebhookPayload(
    [property: JsonPropertyName("event")] string Event,
    [property: JsonPropertyName("server")] WebhookServer Server,
    [property: JsonPropertyName("rule")] string Rule,
    [property: JsonPropertyName("severity")] string Severity,
    [property: JsonPropertyName("detail")] string Detail,
    [property: JsonPropertyName("at")] string At,
    [property: JsonPropertyName("url")] string Url);

public sealed record WebhookServer([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("name")] string Name);

/// <summary>
/// One URL per account: POST JSON with `X-Glimtpanel-Signature: sha256=&lt;hex HMAC-SHA256 of the body&gt;`, 5 s
/// timeout, three attempts (after 1 s, 10 s, 60 s). Runs in the background so a slow receiver never holds the engine.
/// </summary>
public sealed class WebhookChannel : IChannel
{
    public const string ClientName = "webhook";
    public const string SignatureHeader = "X-Glimtpanel-Signature";
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan[] DefaultDelays = [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(60)];

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly AuthSessions _sessions;
    private readonly ILogger<WebhookChannel> _logger;
    private readonly TimeSpan[] _delays;
    private readonly bool _background;

    public WebhookChannel(IHttpClientFactory httpClientFactory, AuthSessions sessions, ILogger<WebhookChannel> logger)
        : this(httpClientFactory, sessions, logger, DefaultDelays, background: true)
    {
    }

    internal WebhookChannel(IHttpClientFactory httpClientFactory, AuthSessions sessions, ILogger<WebhookChannel> logger, TimeSpan[] delays, bool background)
    {
        _httpClientFactory = httpClientFactory;
        _sessions = sessions;
        _logger = logger;
        _delays = delays;
        _background = background;
    }

    public string Name => ChannelNames.Webhook;

    public Task<bool> SendAsync(AlertNotification notification, CancellationToken cancellationToken)
    {
        var url = notification.Settings.Channels.WebhookUrl;
        if (!notification.IsOwner || string.IsNullOrWhiteSpace(url) || !IsValidUrl(url))
        {
            return Task.FromResult(false);
        }

        var e = notification.Event;
        var payload = new WebhookPayload(
            e.Kind,
            new WebhookServer(e.Alert.ServerId, e.ServerName),
            e.Alert.Rule,
            e.Alert.Severity,
            e.Alert.Detail,
            new DateTimeOffset(DateTime.SpecifyKind(e.Kind == AlertEventKinds.Resolved ? e.Alert.ResolvedAt ?? e.Alert.FiredAt : e.Alert.FiredAt, DateTimeKind.Utc)).ToString("o"),
            _sessions.WebLink(AlertTexts.Path(e.Alert)));
        return DeliverAsync(url, notification.Settings.Channels.WebhookSecret, payload, cancellationToken);
    }

    /// <summary>Posts a payload (also used by POST /api/channels/webhook-test). Background: returns true once the attempts are scheduled.</summary>
    public Task<bool> DeliverAsync(string url, string secret, WebhookPayload payload, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(payload);
        var signature = Sign(secret, body);
        if (!_background)
        {
            return AttemptsAsync(url, body, signature, cancellationToken);
        }

        _ = Task.Run(() => AttemptsAsync(url, body, signature, CancellationToken.None), CancellationToken.None);
        return Task.FromResult(true);
    }

    /// <summary>One attempt without retries, for the "Send test" button: the HTTP status, or null when unreachable.</summary>
    public async Task<int?> TryOnceAsync(string url, string secret, WebhookPayload payload, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(payload);
        return await PostAsync(url, body, Sign(secret, body), cancellationToken);
    }

    public static string Sign(string secret, byte[] body) =>
        "sha256=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), body));

    public static bool IsValidUrl(string url) =>
        Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";

    private async Task<bool> AttemptsAsync(string url, byte[] body, string signature, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < _delays.Length; attempt++)
        {
            try
            {
                await Task.Delay(_delays[attempt], cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return false;
            }

            var status = await PostAsync(url, body, signature, cancellationToken);
            if (status is >= 200 and < 300)
            {
                return true;
            }

            _logger.LogWarning("webhook {Url} attempt {Attempt} of {Attempts}: {Status}", Redact(url), attempt + 1, _delays.Length, status?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "unreachable");
        }

        return false;
    }

    private async Task<int?> PostAsync(string url, byte[] body, string signature, CancellationToken cancellationToken)
    {
        try
        {
            using var client = _httpClientFactory.CreateClient(ClientName);
            using var request = new HttpRequestMessage(HttpMethod.Post, url.Trim());
            request.Headers.TryAddWithoutValidation(SignatureHeader, signature);
            request.Headers.TryAddWithoutValidation("User-Agent", "Glimtpanel-Webhook/1.0");
            request.Content = new ByteArrayContent(body);
            request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
            using var response = await client.SendAsync(request, cancellationToken);
            return (int)response.StatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException && !cancellationToken.IsCancellationRequested)
        {
            _logger.LogDebug("webhook {Url} failed: {Error}", Redact(url), ex.Message);
            return null;
        }
    }

    /// <summary>Webhook URLs often carry a token in the path (Slack, Discord): log only the host.</summary>
    private static string Redact(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Host : "webhook";
}
