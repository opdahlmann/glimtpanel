using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Glimt.Hub.Features.Agents;

/// <summary>Long-lived agent tokens. Only the SHA-256 hash is ever stored (IMPLEMENTERINGSPLAN 4.7).</summary>
public static class AgentTokens
{
    public const string Prefix = "agt_";

    public static string Generate() => Prefix + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

    public static bool FixedTimeEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
}
