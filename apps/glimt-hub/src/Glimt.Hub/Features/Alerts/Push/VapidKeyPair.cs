using System.Buffers.Text;
using System.Security.Cryptography;

namespace Glimt.Hub.Features.Alerts.Push;

/// <summary>
/// The hub's P-256 key pair for VAPID (RFC 8292) as <see cref="ECParameters"/>. Imported from the base64url strings
/// in GLIMT_VAPID_PUBLIC (raw 65-byte uncompressed point 0x04‖X‖Y) and GLIMT_VAPID_PRIVATE (32-byte scalar), the
/// format `dotnet run -- vapid-keys` prints and the browser's `applicationServerKey` expects.
/// </summary>
public sealed class VapidKeyPair
{
    public VapidKeyPair(byte[] publicKey, byte[] privateKey)
    {
        if (publicKey.Length != 65 || publicKey[0] != 0x04)
        {
            throw new ArgumentException("VAPID public key must be a 65-byte uncompressed P-256 point", nameof(publicKey));
        }

        if (privateKey.Length != 32)
        {
            throw new ArgumentException("VAPID private key must be 32 bytes", nameof(privateKey));
        }

        PublicKey = publicKey;
        PrivateKey = privateKey;
        Parameters = new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = publicKey[1..33], Y = publicKey[33..65] },
            D = privateKey,
        };
        PublicKeyBase64Url = Base64Url.EncodeToString(publicKey);
    }

    public byte[] PublicKey { get; }

    public byte[] PrivateKey { get; }

    public ECParameters Parameters { get; }

    /// <summary>The `k=` value in the Authorization header, and what the web app gets as `vapidPublic`.</summary>
    public string PublicKeyBase64Url { get; }

    public static VapidKeyPair FromBase64Url(string publicKey, string privateKey) =>
        new(Base64Url.DecodeFromChars(publicKey.Trim()), Base64Url.DecodeFromChars(privateKey.Trim()));

    /// <summary>Null when either key is missing; invalid keys throw so a misconfiguration is visible at startup.</summary>
    public static VapidKeyPair? TryFromOptions(string? publicKey, string? privateKey) =>
        string.IsNullOrWhiteSpace(publicKey) || string.IsNullOrWhiteSpace(privateKey) ? null : FromBase64Url(publicKey, privateKey);

    public static VapidKeyPair Generate()
    {
        var (publicKey, privateKey) = Infrastructure.VapidKeys.Generate();
        return FromBase64Url(publicKey, privateKey);
    }

    public ECDsa CreateSigner()
    {
        var ecdsa = ECDsa.Create();
        ecdsa.ImportParameters(Parameters);
        return ecdsa;
    }
}
