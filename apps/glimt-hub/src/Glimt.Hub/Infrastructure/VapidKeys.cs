using System.Buffers.Text;
using System.Security.Cryptography;

namespace Glimt.Hub.Infrastructure;

/// <summary>
/// `dotnet run -- vapid-keys` prints a fresh P-256 key pair for Web Push (RFC 8292) in the env format
/// the hub expects, then exits without starting the web host.
/// </summary>
public static class VapidKeys
{
    public const string Command = "vapid-keys";

    public static bool TryRun(string[] args, TextWriter output)
    {
        if (args.Length == 0 || !string.Equals(args[0], Command, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var (publicKey, privateKey) = Generate();
        output.WriteLine($"GLIMT_VAPID_PUBLIC={publicKey}");
        output.WriteLine($"GLIMT_VAPID_PRIVATE={privateKey}");
        return true;
    }

    /// <summary>Returns (base64url of the 65-byte uncompressed public point, base64url of the 32-byte private scalar).</summary>
    public static (string PublicKey, string PrivateKey) Generate()
    {
        using var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var p = ecdsa.ExportParameters(true);

        var publicKey = new byte[65];
        publicKey[0] = 0x04;
        CopyLeftPadded(p.Q.X!, publicKey.AsSpan(1, 32));
        CopyLeftPadded(p.Q.Y!, publicKey.AsSpan(33, 32));

        var privateKey = new byte[32];
        CopyLeftPadded(p.D!, privateKey);

        return (Base64Url.EncodeToString(publicKey), Base64Url.EncodeToString(privateKey));
    }

    private static void CopyLeftPadded(byte[] source, Span<byte> destination)
    {
        destination.Clear();
        source.AsSpan().CopyTo(destination[(destination.Length - source.Length)..]);
    }
}
