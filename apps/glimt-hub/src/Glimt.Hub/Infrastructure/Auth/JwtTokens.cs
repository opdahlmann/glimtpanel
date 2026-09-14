using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Glimt.Hub.Infrastructure.Auth;

/// <summary>
/// Issues and validates the short-lived access tokens the browser sends as Bearer (REST) and as
/// <c>access_token</c> query string (SignalR). HMAC-SHA256 with the key derived from GLIMT_JWT_SECRET.
/// Refresh tokens are not JWTs; they live in the refreshTokens collection (step 2.2).
/// </summary>
public sealed class JwtTokens
{
    public const string Issuer = "glimtpanel";
    public const string Audience = "glimt-web";
    public const string LanguageClaim = "lang";
    public static readonly TimeSpan AccessTokenLifetime = TimeSpan.FromMinutes(15);

    private readonly SymmetricSecurityKey _key;
    private readonly TimeProvider _clock;
    private readonly JsonWebTokenHandler _handler = new() { SetDefaultTimesOnTokenCreation = false };

    public JwtTokens(GlimtOptions options, TimeProvider clock)
    {
        _key = new SymmetricSecurityKey(DeriveKey(options.JwtSecret));
        _clock = clock;
    }

    /// <summary>32 bytes for HS256 regardless of how long the configured secret is (SHA-256 of the secret).</summary>
    internal static byte[] DeriveKey(string secret) => SHA256.HashData(Encoding.UTF8.GetBytes(secret));

    public string IssueAccessToken(string userId, string email, string name, string language, TimeSpan? lifetime = null)
    {
        var now = _clock.GetUtcNow();
        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            Audience = Audience,
            IssuedAt = now.UtcDateTime,
            NotBefore = now.UtcDateTime,
            Expires = now.Add(lifetime ?? AccessTokenLifetime).UtcDateTime,
            SigningCredentials = new SigningCredentials(_key, SecurityAlgorithms.HmacSha256),
            Claims = new Dictionary<string, object>
            {
                [JwtRegisteredClaimNames.Sub] = userId,
                [ClaimTypes.NameIdentifier] = userId,
                [JwtRegisteredClaimNames.Email] = email,
                [JwtRegisteredClaimNames.Name] = name,
                [LanguageClaim] = language,
            },
        };
        return _handler.CreateToken(descriptor);
    }

    public static readonly TimeSpan ClockSkew = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Lifetime is checked against the injected clock (not the machine clock), so in e2e a token issued after
    /// POST /api/e2e/advance is valid right away and one issued before it expires as the shifted clock says.
    /// </summary>
    public TokenValidationParameters ValidationParameters => new()
    {
        ValidateIssuer = true,
        ValidIssuer = Issuer,
        ValidateAudience = true,
        ValidAudience = Audience,
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = _key,
        ValidateLifetime = true,
        ClockSkew = ClockSkew,
        LifetimeValidator = (notBefore, expires, _, _) =>
        {
            var now = _clock.GetUtcNow().UtcDateTime;
            return (notBefore is null || notBefore.Value <= now + ClockSkew) && (expires is null || expires.Value >= now - ClockSkew);
        },
        NameClaimType = JwtRegisteredClaimNames.Name,
        RoleClaimType = "role",
    };

    /// <summary>Validates a token and returns the principal, or null when invalid or expired.</summary>
    public async Task<ClaimsPrincipal?> ValidateAsync(string token)
    {
        var result = await _handler.ValidateTokenAsync(token, ValidationParameters);
        return result.IsValid ? new ClaimsPrincipal(result.ClaimsIdentity) : null;
    }
}
