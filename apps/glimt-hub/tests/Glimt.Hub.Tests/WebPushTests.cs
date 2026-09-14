using System.Buffers.Text;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Alerts.Push;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace Glimt.Hub.Tests;

/// <summary>The hub's own Web Push client (IMPLEMENTERINGSPLAN step 7.2): RFC 8291 appendix A bit for bit, VAPID, and response handling.</summary>
public sealed class WebPushTests
{
    // RFC 8291 appendix A: keys, salt, plaintext and the expected ciphertext.
    private const string UaPublic = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    private const string UaPrivate = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    private const string AsPublic = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    private const string AsPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    private const string AuthSecret = "BTBZMqHH6r4Tts7J_aSIgg";
    private const string Salt = "DGv6ra1nlYgDCS1FRnbzlw";
    private const string Plaintext = "When I grow up, I want to be a watermelon";
    private const string Expected = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    private static ECParameters Key(string publicKey, string? privateKey)
    {
        var pub = Base64Url.DecodeFromChars(publicKey);
        return new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = pub[1..33], Y = pub[33..65] },
            D = privateKey is null ? null : Base64Url.DecodeFromChars(privateKey),
        };
    }

    [Fact]
    public void Rfc8291_appendix_a_encrypts_to_the_known_ciphertext()
    {
        var body = WebPushEncryptor.Encrypt(
            Encoding.UTF8.GetBytes(Plaintext),
            Base64Url.DecodeFromChars(UaPublic),
            Base64Url.DecodeFromChars(AuthSecret),
            Key(AsPublic, AsPrivate),
            Base64Url.DecodeFromChars(Salt));
        Assert.Equal(Expected, Base64Url.EncodeToString(body));

        var back = WebPushEncryptor.Decrypt(body, Key(UaPublic, UaPrivate), Base64Url.DecodeFromChars(AuthSecret));
        Assert.Equal(Plaintext, Encoding.UTF8.GetString(back));
    }

    [Fact]
    public void Random_key_and_salt_round_trip_and_the_frame_is_right()
    {
        using var subscriber = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var uaPublic = WebPushEncryptor.ExportRawPublicKey(subscriber);
        var auth = RandomNumberGenerator.GetBytes(16);
        var payload = Encoding.UTF8.GetBytes("{\"title\":\"web-02 · Disk almost full\",\"body\":\"/ · 92 %\"}");

        var body = WebPushEncryptor.Encrypt(payload, uaPublic, auth);
        Assert.Equal(16 + 4 + 1 + 65 + payload.Length + 1 + 16, body.Length);
        Assert.Equal(4096u, System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(body.AsSpan(16, 4)));
        Assert.Equal(65, body[20]);
        Assert.Equal(0x04, body[21]);
        Assert.Equal(payload, WebPushEncryptor.Decrypt(body, subscriber.ExportParameters(true), auth));
    }

    [Fact]
    public void Vapid_token_verifies_with_the_public_key_and_carries_aud_exp_sub()
    {
        var keys = VapidKeyPair.Generate();
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 14, 10, 0, 0, TimeSpan.Zero));
        var vapid = new VapidToken(keys, "mailto:ops@glimtpanel.com", clock);
        var endpoint = new Uri("https://fcm.googleapis.com/fcm/send/abc123");

        var header = vapid.AuthorizationHeader(endpoint);
        Assert.StartsWith("vapid t=", header);
        Assert.EndsWith(", k=" + keys.PublicKeyBase64Url, header);
        var token = header["vapid t=".Length..header.IndexOf(", k=", StringComparison.Ordinal)];

        var claims = VapidToken.Verify(token, keys.PublicKey);
        Assert.NotNull(claims);
        Assert.Equal("https://fcm.googleapis.com", claims.Value.GetProperty("aud").GetString());
        Assert.Equal("mailto:ops@glimtpanel.com", claims.Value.GetProperty("sub").GetString());
        Assert.Equal(clock.GetUtcNow().AddHours(12).ToUnixTimeSeconds(), claims.Value.GetProperty("exp").GetInt64());
        var headerJson = Encoding.UTF8.GetString(Base64Url.DecodeFromChars(token.Split('.')[0]));
        Assert.Equal("{\"typ\":\"JWT\",\"alg\":\"ES256\"}", headerJson);

        // Cached for an hour per audience, then re-signed.
        Assert.Equal(token, vapid.TokenFor("https://fcm.googleapis.com"));
        clock.Advance(TimeSpan.FromMinutes(61));
        Assert.NotEqual(token, vapid.TokenFor("https://fcm.googleapis.com"));

        var other = VapidKeyPair.Generate();
        Assert.Null(VapidToken.Verify(token, other.PublicKey));
    }

    [Fact]
    public void Key_pair_round_trips_through_the_env_format()
    {
        var (publicKey, privateKey) = Infrastructure.VapidKeys.Generate();
        var pair = VapidKeyPair.FromBase64Url(publicKey, privateKey);
        Assert.Equal(publicKey, pair.PublicKeyBase64Url);
        Assert.Equal(32, pair.PrivateKey.Length);
        Assert.Null(VapidKeyPair.TryFromOptions("", privateKey));
        Assert.Throws<ArgumentException>(() => VapidKeyPair.FromBase64Url(publicKey[..40], privateKey));
    }

    [Theory]
    [InlineData(HttpStatusCode.Created, PushOutcome.Delivered, 1, 0)]
    [InlineData(HttpStatusCode.NotFound, PushOutcome.Gone, 1, 1)]
    [InlineData(HttpStatusCode.Gone, PushOutcome.Gone, 1, 1)]
    [InlineData(HttpStatusCode.RequestEntityTooLarge, PushOutcome.TooLarge, 1, 0)]
    [InlineData(HttpStatusCode.Forbidden, PushOutcome.Rejected, 1, 0)]
    [InlineData(HttpStatusCode.TooManyRequests, PushOutcome.Unavailable, 2, 0)]
    [InlineData(HttpStatusCode.BadGateway, PushOutcome.Unavailable, 2, 0)]
    public async Task Responses_map_to_outcomes_and_gone_removes_the_subscription(HttpStatusCode status, PushOutcome expected, int requests, int removed)
    {
        var store = new InMemoryAlertStore();
        var subscription = Subscription("u1");
        store.Subscriptions.Add(subscription);
        var handler = new RecordingHandler(status);
        var client = Client(handler, store);

        var outcome = await client.SendAsync(subscription, new PushPayload("web-02 · Disk almost full", "/ · 92 %", "/servers/s1#disk", "s1:disk_full"), urgent: true, "s1-disk_full", CancellationToken.None);
        Assert.Equal(expected, outcome);
        Assert.Equal(requests, handler.Requests.Count);
        Assert.Equal(1 - removed, store.Subscriptions.Count);

        var request = handler.Requests[0];
        Assert.Equal("aes128gcm", request.ContentEncoding);
        Assert.Equal("application/octet-stream", request.ContentType);
        Assert.Equal("86400", request.Headers["TTL"]);
        Assert.Equal("high", request.Headers["Urgency"]);
        Assert.Equal("s1-disk_full", request.Headers["Topic"]);
        Assert.StartsWith("vapid t=", request.Headers["Authorization"]);
        Assert.True(request.Body.Length > 86);
    }

    [Fact]
    public async Task Delivered_payload_decrypts_on_the_subscriber_side()
    {
        var store = new InMemoryAlertStore();
        using var subscriber = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var auth = RandomNumberGenerator.GetBytes(16);
        var subscription = new PushSubscriptionDocument
        {
            UserId = "u1",
            Endpoint = "https://push.example/sub/1",
            P256dh = Base64Url.EncodeToString(WebPushEncryptor.ExportRawPublicKey(subscriber)),
            Auth = Base64Url.EncodeToString(auth),
            Device = "test",
        };
        var handler = new RecordingHandler(HttpStatusCode.Created);
        var payload = new PushPayload("web-02 · Disk almost full", "/ · 92 %", "/servers/s1#disk", "s1:disk_full");
        Assert.Equal(PushOutcome.Delivered, await Client(handler, store).SendAsync(subscription, payload, false, "s1-disk_full", CancellationToken.None));

        var plain = WebPushEncryptor.Decrypt(handler.Requests[0].Body, subscriber.ExportParameters(true), auth);
        var json = JsonSerializer.Deserialize<JsonElement>(plain);
        Assert.Equal("web-02 · Disk almost full", json.GetProperty("title").GetString());
        Assert.Equal("/servers/s1#disk", json.GetProperty("url").GetString());
        Assert.Equal("normal", handler.Requests[0].Headers["Urgency"]);
    }

    [Fact]
    public async Task Without_keys_nothing_is_sent_and_bad_subscriptions_are_removed()
    {
        var store = new InMemoryAlertStore();
        var handler = new RecordingHandler(HttpStatusCode.Created);
        var unconfigured = new WebPushClient(new SingleHandlerFactory(handler), store, null, null, TimeProvider.System, NullLogger<WebPushClient>.Instance, (_, _) => Task.CompletedTask);
        Assert.False(unconfigured.IsConfigured);
        Assert.Equal(PushOutcome.NotConfigured, await unconfigured.SendAsync(Subscription("u1"), new PushPayload("t", "b", "/", "x"), false, "x", CancellationToken.None));

        var bad = Subscription("u1");
        bad.P256dh = "not-a-key";
        store.Subscriptions.Add(bad);
        Assert.Equal(PushOutcome.Failed, await Client(handler, store).SendAsync(bad, new PushPayload("t", "b", "/", "x"), false, "x", CancellationToken.None));
        Assert.Empty(store.Subscriptions);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public void Topics_are_base64url_safe_and_at_most_32_characters()
    {
        Assert.Equal("demo-web-02-disk_full", WebPushClient.SafeTopic("demo-web-02-disk_full"));
        Assert.Equal("a-b-c", WebPushClient.SafeTopic("a:b.c"));
        Assert.Equal(32, WebPushClient.SafeTopic(new string('x', 40)).Length);
    }

    private static PushSubscriptionDocument Subscription(string userId)
    {
        using var subscriber = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        return new PushSubscriptionDocument
        {
            UserId = userId,
            Endpoint = "https://push.example/sub/" + Guid.NewGuid().ToString("N"),
            P256dh = Base64Url.EncodeToString(WebPushEncryptor.ExportRawPublicKey(subscriber)),
            Auth = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(16)),
            Device = "MacBook · Chrome",
        };
    }

    private static WebPushClient Client(RecordingHandler handler, IAlertStore store) =>
        new(new SingleHandlerFactory(handler), store, VapidKeyPair.Generate(), "mailto:test@glimtpanel.com", TimeProvider.System, NullLogger<WebPushClient>.Instance, (_, _) => Task.CompletedTask);

    internal sealed record RecordedRequest(Uri Url, Dictionary<string, string> Headers, string? ContentType, string? ContentEncoding, byte[] Body);

    internal sealed class RecordingHandler(HttpStatusCode status) : HttpMessageHandler
    {
        public List<RecordedRequest> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
            var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken);
            Requests.Add(new RecordedRequest(request.RequestUri!, headers, request.Content?.Headers.ContentType?.MediaType, request.Content?.Headers.ContentEncoding.FirstOrDefault(), body));
            return new HttpResponseMessage(status) { Content = new StringContent("") };
        }
    }

    internal sealed class SingleHandlerFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}
