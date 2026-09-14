using System.Buffers.Text;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Alerts.Push;

/// <summary>What the browser shows (IMPLEMENTERINGSPLAN step 7.2). At most 3 kB as JSON.</summary>
public sealed record PushPayload(
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("body")] string Body,
    [property: JsonPropertyName("url")] string Url,
    [property: JsonPropertyName("tag")] string Tag);

public enum PushOutcome
{
    /// <summary>201 (or any 2xx).</summary>
    Delivered,

    /// <summary>404 or 410: the subscription is dead and has been deleted.</summary>
    Gone,

    /// <summary>413: logged; the payload was already minimal.</summary>
    TooLarge,

    /// <summary>429 or 5xx after the one retry.</summary>
    Unavailable,

    /// <summary>400, 401 or 403: the push service rejected the VAPID token for this audience.</summary>
    Rejected,

    /// <summary>Transport error or an invalid subscription.</summary>
    Failed,

    /// <summary>No VAPID keys configured; nothing was sent.</summary>
    NotConfigured,
}

/// <summary>Where the push channel and the tests meet; the real client is <see cref="WebPushClient"/>.</summary>
public interface IWebPushClient
{
    bool IsConfigured { get; }

    Task<PushOutcome> SendAsync(PushSubscriptionDocument subscription, PushPayload payload, bool urgent, string topic, CancellationToken cancellationToken);
}

/// <summary>
/// RFC 8030 delivery: POST the aes128gcm body to the subscription endpoint with Content-Encoding, TTL, Urgency and
/// Topic (so a reminder replaces the previous message), Authorization from <see cref="VapidToken"/>. Response handling:
/// 2xx ok; 404/410 delete the subscription; 413 log; 429/5xx retry once after 30 s (with jitter); 400/401/403 log as a
/// VAPID error with the audience. Delays are injectable for the tests.
/// </summary>
public sealed class WebPushClient : IWebPushClient
{
    public const string ClientName = "webpush";
    public const int Ttl = 86_400;
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan RetryAfter = TimeSpan.FromSeconds(30);

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IAlertStore _store;
    private readonly ILogger<WebPushClient> _logger;
    private readonly VapidKeyPair? _keys;
    private readonly VapidToken? _token;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;

    public WebPushClient(IHttpClientFactory httpClientFactory, IAlertStore store, GlimtOptions options, TimeProvider clock, ILogger<WebPushClient> logger)
        : this(httpClientFactory, store, VapidKeyPair.TryFromOptions(options.VapidPublic, options.VapidPrivate), options.VapidSubject, clock, logger, null)
    {
    }

    internal WebPushClient(
        IHttpClientFactory httpClientFactory,
        IAlertStore store,
        VapidKeyPair? keys,
        string? subject,
        TimeProvider clock,
        ILogger<WebPushClient> logger,
        Func<TimeSpan, CancellationToken, Task>? delay)
    {
        _httpClientFactory = httpClientFactory;
        _store = store;
        _logger = logger;
        _keys = keys;
        _token = keys is null ? null : new VapidToken(keys, string.IsNullOrWhiteSpace(subject) ? "mailto:hub@glimtpanel.com" : subject.Trim(), clock);
        _delay = delay ?? ((wait, ct) => Task.Delay(wait + TimeSpan.FromMilliseconds(Random.Shared.Next(0, 5000)), ct));
    }

    public bool IsConfigured => _keys is not null;

    public async Task<PushOutcome> SendAsync(PushSubscriptionDocument subscription, PushPayload payload, bool urgent, string topic, CancellationToken cancellationToken)
    {
        if (_keys is null || _token is null)
        {
            return PushOutcome.NotConfigured;
        }

        if (!Uri.TryCreate(subscription.Endpoint, UriKind.Absolute, out var endpoint) || endpoint.Scheme != "https")
        {
            _logger.LogWarning("push subscription {Id} has an invalid endpoint; removing it", subscription.Id);
            await _store.DeleteSubscriptionByEndpointAsync(subscription.Endpoint, cancellationToken);
            return PushOutcome.Failed;
        }

        byte[] body;
        try
        {
            var json = JsonSerializer.SerializeToUtf8Bytes(payload);
            body = WebPushEncryptor.Encrypt(json, Base64Url.DecodeFromChars(subscription.P256dh), Base64Url.DecodeFromChars(subscription.Auth));
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException or System.Security.Cryptography.CryptographicException)
        {
            _logger.LogWarning("push subscription {Id} has unusable keys ({Error}); removing it", subscription.Id, ex.Message);
            await _store.DeleteSubscriptionByEndpointAsync(subscription.Endpoint, cancellationToken);
            return PushOutcome.Failed;
        }

        var outcome = await PostAsync(endpoint, body, urgent, topic, cancellationToken);
        if (outcome == PushOutcome.Unavailable)
        {
            await _delay(RetryAfter, cancellationToken);
            outcome = await PostAsync(endpoint, body, urgent, topic, cancellationToken);
        }

        if (outcome == PushOutcome.Gone)
        {
            await _store.DeleteSubscriptionByEndpointAsync(subscription.Endpoint, cancellationToken);
        }

        return outcome;
    }

    private async Task<PushOutcome> PostAsync(Uri endpoint, byte[] body, bool urgent, string topic, CancellationToken cancellationToken)
    {
        try
        {
            using var client = _httpClientFactory.CreateClient(ClientName);
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Headers.TryAddWithoutValidation("Authorization", _token!.AuthorizationHeader(endpoint));
            request.Headers.TryAddWithoutValidation("TTL", Ttl.ToString(System.Globalization.CultureInfo.InvariantCulture));
            request.Headers.TryAddWithoutValidation("Urgency", urgent ? "high" : "normal");
            request.Headers.TryAddWithoutValidation("Topic", SafeTopic(topic));
            request.Content = new ByteArrayContent(body);
            request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
            request.Content.Headers.ContentEncoding.Add("aes128gcm");

            using var response = await client.SendAsync(request, cancellationToken);
            var status = (int)response.StatusCode;
            switch (response.StatusCode)
            {
                case HttpStatusCode.NotFound or HttpStatusCode.Gone:
                    _logger.LogInformation("push endpoint {Host} says {Status}: subscription removed", endpoint.Host, status);
                    return PushOutcome.Gone;
                case HttpStatusCode.RequestEntityTooLarge:
                    _logger.LogWarning("push endpoint {Host} rejected the payload as too large ({Bytes} bytes)", endpoint.Host, body.Length);
                    return PushOutcome.TooLarge;
                case HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden:
                    _logger.LogError("push endpoint {Host} rejected the VAPID token ({Status}) for aud {Audience}: {Body}", endpoint.Host, status, VapidToken.Audience(endpoint), await Snippet(response, cancellationToken));
                    return PushOutcome.Rejected;
                case HttpStatusCode.TooManyRequests or >= HttpStatusCode.InternalServerError:
                    _logger.LogWarning("push endpoint {Host} answered {Status}", endpoint.Host, status);
                    return PushOutcome.Unavailable;
            }

            if (response.IsSuccessStatusCode)
            {
                return PushOutcome.Delivered;
            }

            _logger.LogWarning("push endpoint {Host} answered {Status}: {Body}", endpoint.Host, status, await Snippet(response, cancellationToken));
            return PushOutcome.Failed;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("push to {Host} failed: {Error}", endpoint.Host, ex.Message);
            return PushOutcome.Unavailable;
        }
    }

    /// <summary>RFC 8030 §5.4: at most 32 characters from the base64url alphabet.</summary>
    public static string SafeTopic(string topic)
    {
        var chars = topic.Select(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' ? c : '-').ToArray();
        return new string(chars, 0, Math.Min(32, chars.Length));
    }

    private static async Task<string> Snippet(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        return text.Length <= 200 ? text : text[..200] + "…";
    }
}
