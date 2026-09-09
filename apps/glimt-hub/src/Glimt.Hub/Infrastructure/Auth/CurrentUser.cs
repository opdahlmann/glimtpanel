using System.Security.Claims;
using Microsoft.IdentityModel.JsonWebTokens;

namespace Glimt.Hub.Infrastructure.Auth;

public static class CurrentUser
{
    /// <summary>The user id from the access token (sub / NameIdentifier), or null when anonymous.</summary>
    public static string? GetUserId(this ClaimsPrincipal principal) =>
        principal.FindFirstValue(ClaimTypes.NameIdentifier) ?? principal.FindFirstValue(JwtRegisteredClaimNames.Sub);

    public static string RequireUserId(this ClaimsPrincipal principal) =>
        principal.GetUserId() ?? throw new UnauthorizedAccessException("no user id in principal");

    public static string? GetEmail(this ClaimsPrincipal principal) =>
        principal.FindFirstValue(JwtRegisteredClaimNames.Email) ?? principal.FindFirstValue(ClaimTypes.Email);

    public static string GetLanguage(this ClaimsPrincipal principal) =>
        principal.FindFirstValue(JwtTokens.LanguageClaim) ?? "en";
}
