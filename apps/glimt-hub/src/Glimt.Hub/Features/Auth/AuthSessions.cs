using Glimt.Hub.Features.Access;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Auth;

namespace Glimt.Hub.Features.Auth;

/// <summary>
/// Turns a user into a browser session: a 15-minute access token in the body and a 30-day refresh token in the
/// httpOnly cookie <c>glimt_refresh</c> (Secure on https, SameSite=Lax, path /api/auth). Also builds the "me" payload.
/// </summary>
public sealed class AuthSessions(
    JwtTokens jwt,
    RefreshTokenStore refreshTokens,
    IServerStore servers,
    AccessGrantStore grants,
    GlimtOptions options,
    TimeProvider clock)
{
    public const string CookieName = "glimt_refresh";
    public const string CookiePath = "/api/auth";

    /// <summary>Issues a new refresh token (cookie) and access token for the user.</summary>
    public async Task<LoginResponse> IssueAsync(HttpContext http, UserDocument user, CancellationToken cancellationToken)
    {
        var (token, expiresAt) = await refreshTokens.CreateAsync(user.Id, http.Request.Headers.UserAgent.ToString(), cancellationToken);
        SetCookie(http, token, expiresAt);
        return AccessOnly(user);
    }

    /// <summary>A fresh access token without touching the refresh cookie.</summary>
    public LoginResponse AccessOnly(UserDocument user)
    {
        var now = clock.GetUtcNow();
        var accessToken = jwt.IssueAccessToken(user.Id, user.Email, user.Name, user.Language);
        return new LoginResponse(accessToken, now.Add(JwtTokens.AccessTokenLifetime), UserDto.From(user));
    }

    public static string? ReadCookie(HttpContext http) =>
        http.Request.Cookies.TryGetValue(CookieName, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;

    public static void ClearCookie(HttpContext http) =>
        http.Response.Cookies.Delete(CookieName, new CookieOptions { Path = CookiePath, HttpOnly = true, Secure = http.Request.IsHttps, SameSite = SameSiteMode.Lax });

    public async Task<MeDto> MeAsync(UserDocument user, CancellationToken cancellationToken)
    {
        var owned = await servers.CountByOwnerAsync(user.Id, cancellationToken);
        var received = await grants.ListAcceptedForUserAsync(user.Id, cancellationToken);
        return MeDto.From(user, owned > 0, received.Count);
    }

    /// <summary>Absolute link into the web app, e.g. /confirm?token=…</summary>
    public string WebLink(string path, string? token = null)
    {
        var baseUrl = (options.WebPublicUrl ?? options.HubPublicUrl ?? options.HubUrl).TrimEnd('/');
        return token is null ? baseUrl + path : $"{baseUrl}{path}?token={Uri.EscapeDataString(token)}";
    }

    private static void SetCookie(HttpContext http, string token, DateTime expiresAt) =>
        http.Response.Cookies.Append(CookieName, token, new CookieOptions
        {
            HttpOnly = true,
            Secure = http.Request.IsHttps,
            SameSite = SameSiteMode.Lax,
            Path = CookiePath,
            Expires = new DateTimeOffset(DateTime.SpecifyKind(expiresAt, DateTimeKind.Utc)),
            IsEssential = true,
        });
}
