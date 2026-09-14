using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Glimt.Hub.Features.Alerts.Push;

/// <summary>
/// VAPID (RFC 8292): a JWT with header {"typ":"JWT","alg":"ES256"} and claims aud (origin of the push endpoint),
/// exp (now + 12 h) and sub (GLIMT_VAPID_SUBJECT), signed ES256 with the hub's key. Tokens are cached per audience
/// for an hour, so a burst of pushes to the same service signs once.
/// </summary>
public sealed class VapidToken(VapidKeyPair keys, string subject, TimeProvider clock)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);
    public static readonly TimeSpan CacheFor = TimeSpan.FromHours(1);

    private static readonly byte[] Header = Encoding.ASCII.GetBytes(Base64Url.EncodeToString("{\"typ\":\"JWT\",\"alg\":\"ES256\"}"u8));

    private readonly ConcurrentDictionary<string, (string Token, DateTimeOffset At)> _cache = new(StringComparer.Ordinal);

    public string Subject { get; } = subject;

    /// <summary>`vapid t=&lt;jwt&gt;, k=&lt;public key&gt;` for the push endpoint's origin.</summary>
    public string AuthorizationHeader(Uri endpoint) => $"vapid t={TokenFor(Audience(endpoint))}, k={keys.PublicKeyBase64Url}";

    public static string Audience(Uri endpoint) => endpoint.GetLeftPart(UriPartial.Authority);

    public string TokenFor(string audience)
    {
        var now = clock.GetUtcNow();
        if (_cache.TryGetValue(audience, out var hit) && now - hit.At < CacheFor)
        {
            return hit.Token;
        }

        var token = Sign(audience, now);
        _cache[audience] = (token, now);
        return token;
    }

    private string Sign(string audience, DateTimeOffset now)
    {
        var claims = JsonSerializer.SerializeToUtf8Bytes(new { aud = audience, exp = (now + Lifetime).ToUnixTimeSeconds(), sub = Subject });
        var encodedClaims = Base64Url.EncodeToUtf8(claims);
        var signingInput = new byte[Header.Length + 1 + encodedClaims.Length];
        Header.CopyTo(signingInput, 0);
        signingInput[Header.Length] = (byte)'.';
        encodedClaims.CopyTo(signingInput, Header.Length + 1);

        using var ecdsa = keys.CreateSigner();
        var signature = ecdsa.SignData(signingInput, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return Encoding.ASCII.GetString(signingInput) + "." + Base64Url.EncodeToString(signature);
    }

    /// <summary>Verifies a token against a public key and returns its claims (tests, and the push channel's self-check).</summary>
    public static JsonElement? Verify(string token, byte[] publicKey)
    {
        var parts = token.Split('.');
        if (parts.Length != 3)
        {
            return null;
        }

        using var ecdsa = ECDsa.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = publicKey[1..33], Y = publicKey[33..65] },
        });
        var signingInput = Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]);
        var signature = Base64Url.DecodeFromChars(parts[2]);
        if (!ecdsa.VerifyData(signingInput, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
        {
            return null;
        }

        using var document = JsonDocument.Parse(Base64Url.DecodeFromChars(parts[1]));
        return document.RootElement.Clone();
    }
}
