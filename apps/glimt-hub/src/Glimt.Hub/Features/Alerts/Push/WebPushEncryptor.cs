using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Glimt.Hub.Features.Alerts.Push;

/// <summary>
/// Message encryption for Web Push (RFC 8291) with the aes128gcm content encoding (RFC 8188), written against the
/// framework primitives only. Per message: an ephemeral P-256 key, ECDH against the subscriber's p256dh, HKDF-SHA256
/// with the subscriber's auth secret as salt and info "WebPush: info\0" ‖ ua_public ‖ as_public → IKM (32 bytes),
/// then a random 16-byte salt → CEK ("Content-Encoding: aes128gcm\0", 16 bytes) and nonce ("Content-Encoding: nonce\0",
/// 12 bytes), AES-128-GCM over payload ‖ 0x02 (last record delimiter), framed as salt(16) ‖ rs(4) ‖ idlen(1) ‖ as_public(65).
/// The ephemeral key and the salt can be injected, so RFC 8291 appendix A runs bit for bit in the tests.
/// </summary>
public static class WebPushEncryptor
{
    public const int RecordSize = 4096;
    private const int TagLength = 16;
    private static readonly byte[] InfoPrefix = "WebPush: info\0"u8.ToArray();
    private static readonly byte[] CekInfo = "Content-Encoding: aes128gcm\0"u8.ToArray();
    private static readonly byte[] NonceInfo = "Content-Encoding: nonce\0"u8.ToArray();

    /// <summary>Largest payload that fits in one record with the framing (the push services cap the body at 4 kB).</summary>
    public const int MaxPayloadLength = RecordSize - TagLength - 1 - 86;

    /// <summary>Encrypts <paramref name="payload"/> for the subscriber identified by its raw public key and auth secret.</summary>
    public static byte[] Encrypt(byte[] payload, byte[] subscriberPublicKey, byte[] authSecret) =>
        Encrypt(payload, subscriberPublicKey, authSecret, null, RandomNumberGenerator.GetBytes(16));

    /// <summary>The deterministic variant: an explicit sender key pair (as ECParameters with D) and salt.</summary>
    public static byte[] Encrypt(byte[] payload, byte[] subscriberPublicKey, byte[] authSecret, ECParameters? senderKey, byte[] salt)
    {
        if (subscriberPublicKey.Length != 65 || subscriberPublicKey[0] != 0x04)
        {
            throw new ArgumentException("subscriber key must be a 65-byte uncompressed P-256 point", nameof(subscriberPublicKey));
        }

        if (salt.Length != 16)
        {
            throw new ArgumentException("salt must be 16 bytes", nameof(salt));
        }

        if (payload.Length > MaxPayloadLength)
        {
            throw new ArgumentException($"payload must be at most {MaxPayloadLength} bytes", nameof(payload));
        }

        using var sender = senderKey is { } parameters ? ECDiffieHellman.Create(parameters) : ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var senderPublic = ExportRawPublicKey(sender);

        using var subscriber = ECDiffieHellman.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = subscriberPublicKey[1..33], Y = subscriberPublicKey[33..65] },
        });
        var ecdhSecret = sender.DeriveRawSecretAgreement(subscriber.PublicKey);

        var keyInfo = new byte[InfoPrefix.Length + 65 + 65];
        InfoPrefix.CopyTo(keyInfo, 0);
        subscriberPublicKey.CopyTo(keyInfo, InfoPrefix.Length);
        senderPublic.CopyTo(keyInfo, InfoPrefix.Length + 65);
        var ikm = HKDF.DeriveKey(HashAlgorithmName.SHA256, ecdhSecret, 32, authSecret, keyInfo);
        var cek = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 16, salt, CekInfo);
        var nonce = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 12, salt, NonceInfo);

        var plaintext = new byte[payload.Length + 1];
        payload.CopyTo(plaintext, 0);
        plaintext[^1] = 0x02;
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[TagLength];
        using (var aes = new AesGcm(cek, TagLength))
        {
            aes.Encrypt(nonce, plaintext, ciphertext, tag);
        }

        var body = new byte[16 + 4 + 1 + 65 + ciphertext.Length + TagLength];
        var offset = 0;
        salt.CopyTo(body, offset);
        offset += 16;
        BinaryPrimitives.WriteUInt32BigEndian(body.AsSpan(offset, 4), RecordSize);
        offset += 4;
        body[offset++] = 65;
        senderPublic.CopyTo(body, offset);
        offset += 65;
        ciphertext.CopyTo(body, offset);
        offset += ciphertext.Length;
        tag.CopyTo(body, offset);
        return body;
    }

    /// <summary>Decrypts a body produced by <see cref="Encrypt(byte[], byte[], byte[], ECParameters?, byte[])"/> with the subscriber's private key (tests).</summary>
    public static byte[] Decrypt(byte[] body, ECParameters subscriberKey, byte[] authSecret)
    {
        var salt = body[..16];
        var senderPublic = body[21..86];
        var subscriberPublic = new byte[65];
        subscriberPublic[0] = 0x04;
        subscriberKey.Q.X!.CopyTo(subscriberPublic, 1);
        subscriberKey.Q.Y!.CopyTo(subscriberPublic, 33);

        using var subscriber = ECDiffieHellman.Create(subscriberKey);
        using var sender = ECDiffieHellman.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = senderPublic[1..33], Y = senderPublic[33..65] },
        });
        var ecdhSecret = subscriber.DeriveRawSecretAgreement(sender.PublicKey);
        var keyInfo = new byte[InfoPrefix.Length + 130];
        InfoPrefix.CopyTo(keyInfo, 0);
        subscriberPublic.CopyTo(keyInfo, InfoPrefix.Length);
        senderPublic.CopyTo(keyInfo, InfoPrefix.Length + 65);
        var ikm = HKDF.DeriveKey(HashAlgorithmName.SHA256, ecdhSecret, 32, authSecret, keyInfo);
        var cek = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 16, salt, CekInfo);
        var nonce = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 12, salt, NonceInfo);

        var ciphertext = body[86..^TagLength];
        var tag = body[^TagLength..];
        var plaintext = new byte[ciphertext.Length];
        using var aes = new AesGcm(cek, TagLength);
        aes.Decrypt(nonce, ciphertext, tag, plaintext);
        var delimiter = Array.LastIndexOf(plaintext, (byte)0x02);
        return plaintext[..delimiter];
    }

    /// <summary>0x04 ‖ X ‖ Y, each coordinate left-padded to 32 bytes.</summary>
    public static byte[] ExportRawPublicKey(ECDiffieHellman key)
    {
        var p = key.ExportParameters(false);
        var raw = new byte[65];
        raw[0] = 0x04;
        p.Q.X!.CopyTo(raw.AsSpan(1 + 32 - p.Q.X!.Length));
        p.Q.Y!.CopyTo(raw.AsSpan(33 + 32 - p.Q.Y!.Length));
        return raw;
    }

    public static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);
}
