using System.Security.Cryptography;
using System.Text;

namespace Glimt.Hub.Features.Servers;

public static class ServerIds
{
    private const string Alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

    /// <summary>Stable id for the dev agent container: dev-&lt;slug of hostname&gt;.</summary>
    public static string ForDev(string hostname) => "dev-" + Slug(hostname);

    /// <summary>Random 12-character id for real enrolments (step 2.4), like "8f3kq2mlx9rt".</summary>
    public static string New() => RandomNumberGenerator.GetString(Alphabet, 12);

    public static string Slug(string value)
    {
        var sb = new StringBuilder(value.Length);
        var pendingDash = false;
        foreach (var ch in value.ToLowerInvariant())
        {
            if (ch is (>= 'a' and <= 'z') or (>= '0' and <= '9'))
            {
                if (pendingDash && sb.Length > 0)
                {
                    sb.Append('-');
                }

                pendingDash = false;
                sb.Append(ch);
            }
            else
            {
                pendingDash = true;
            }
        }

        return sb.Length == 0 ? "server" : sb.ToString();
    }
}
