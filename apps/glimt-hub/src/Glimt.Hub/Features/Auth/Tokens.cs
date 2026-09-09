using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Glimt.Hub.Features.Auth;

/// <summary>Random opaque tokens for refresh, e-mail links and invitations. Only SHA-256 hashes are stored.</summary>
public static class Tokens
{
    public static string Generate(int bytes = 32) => Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(bytes));

    public static string Hash(string token) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
}
