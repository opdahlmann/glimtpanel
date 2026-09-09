using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace Glimt.Hub.Infrastructure;

/// <summary>
/// Argon2id (64 MB, 3 iterations, parallelism 1, 16-byte salt, 32-byte hash) encoded in the PHC string
/// format: $argon2id$v=19$m=65536,t=3,p=1$&lt;salt&gt;$&lt;hash&gt; with unpadded base64.
/// </summary>
public static class PasswordHasher
{
    private const int SaltBytes = 16;
    private const int HashBytes = 32;
    private const int MemoryKb = 64 * 1024;
    private const int Iterations = 3;
    private const int Parallelism = 1;

    public static string Hash(string password)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Derive(password, salt, MemoryKb, Iterations, Parallelism, HashBytes);
        return $"$argon2id$v=19$m={MemoryKb},t={Iterations},p={Parallelism}${Encode(salt)}${Encode(hash)}";
    }

    public static bool Verify(string password, string encoded)
    {
        if (string.IsNullOrEmpty(password) || string.IsNullOrEmpty(encoded))
        {
            return false;
        }

        var parts = encoded.Split('$');
        if (parts.Length != 6 || parts[0].Length != 0 || parts[1] != "argon2id" || parts[2] != "v=19")
        {
            return false;
        }

        int? memory = null, iterations = null, parallelism = null;
        foreach (var kv in parts[3].Split(','))
        {
            var eq = kv.IndexOf('=');
            if (eq <= 0 || !int.TryParse(kv[(eq + 1)..], out var n) || n <= 0)
            {
                return false;
            }

            switch (kv[..eq])
            {
                case "m": memory = n; break;
                case "t": iterations = n; break;
                case "p": parallelism = n; break;
                default: return false;
            }
        }

        if (memory is null || iterations is null || parallelism is null)
        {
            return false;
        }

        byte[] salt, expected;
        try
        {
            salt = Decode(parts[4]);
            expected = Decode(parts[5]);
        }
        catch (FormatException)
        {
            return false;
        }

        if (salt.Length == 0 || expected.Length == 0)
        {
            return false;
        }

        var actual = Derive(password, salt, memory.Value, iterations.Value, parallelism.Value, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    private static byte[] Derive(string password, byte[] salt, int memoryKb, int iterations, int parallelism, int length)
    {
        using var argon = new Argon2id(Encoding.UTF8.GetBytes(password))
        {
            Salt = salt,
            MemorySize = memoryKb,
            Iterations = iterations,
            DegreeOfParallelism = parallelism,
        };
        return argon.GetBytes(length);
    }

    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=');

    private static byte[] Decode(string text)
    {
        var padded = text.Length % 4 == 0 ? text : text + new string('=', 4 - text.Length % 4);
        return Convert.FromBase64String(padded);
    }
}
