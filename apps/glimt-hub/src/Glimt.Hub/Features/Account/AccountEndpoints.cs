using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Auth;
using Glimt.Hub.Infrastructure.Servers;
using Microsoft.AspNetCore.Mvc;

namespace Glimt.Hub.Features.Account;

public sealed record PatchAccountRequest(string? Name, string? Timezone, string? Language);

public sealed record DeleteAccountRequest(string? Password);

/// <summary>/api/account and /api/subscription (IMPLEMENTERINGSPLAN 4.3, steps 2.3 and 2.9).</summary>
public static class AccountEndpoints
{
    public const string ExportFileName = "glimtpanel-export.json";

    private static readonly JsonSerializerOptions ExportJson = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static IEndpointRouteBuilder MapAccountEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api")
            .RequireAuthorization()
            .RequireRateLimiting(RateLimiting.ApiPolicy)
            .AddEndpointFilter<RequireDatabase>();
        group.MapGet("/account", GetAsync);
        group.MapPatch("/account", PatchAsync);
        group.MapDelete("/account", DeleteAsync);
        group.MapGet("/account/export", ExportAsync);
        group.MapGet("/subscription", SubscriptionAsync);
        return app;
    }

    private static async Task<IResult> GetAsync(ClaimsPrincipal principal, UserStore users, AuthSessions sessions, CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        return user is null ? Validation.Unauthorized() : Results.Ok(await sessions.MeAsync(user, cancellationToken));
    }

    private static async Task<IResult> PatchAsync(
        PatchAccountRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        AuthSessions sessions,
        CancellationToken cancellationToken)
    {
        var errors = new Dictionary<string, string[]>();
        string? name = null;
        if (request.Name is not null)
        {
            name = Validation.NormalizeName(request.Name);
            if (name is null)
            {
                errors["name"] = [$"Name must be 1–{Validation.NameMaxLength} characters."];
            }
        }

        string? timezone = null;
        if (request.Timezone is not null)
        {
            timezone = request.Timezone.Trim();
            if (!Validation.IsTimezone(timezone))
            {
                errors["timezone"] = ["Unknown time zone. Use an IANA name such as Europe/Oslo."];
            }
        }

        string? language = null;
        if (request.Language is not null)
        {
            language = request.Language.Trim().ToLowerInvariant();
            if (!Validation.IsLanguage(language))
            {
                errors["language"] = ["Language must be en or no."];
            }
        }

        if (errors.Count > 0)
        {
            return Validation.ValidationProblem(errors);
        }

        var user = await users.UpdateProfileAsync(principal.RequireUserId(), name, timezone, language, cancellationToken);
        return user is null ? Validation.Unauthorized() : Results.Ok(await sessions.MeAsync(user, cancellationToken));
    }

    private static async Task<IResult> SubscriptionAsync(ClaimsPrincipal principal, UserStore users, IServerStore servers, CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        var used = await servers.CountByOwnerAsync(user.Id, cancellationToken);
        return Results.Ok(Subscription.Compute((int)used, user.EarlyAdopter, user.Plan));
    }

    private static async Task<IResult> ExportAsync(ClaimsPrincipal principal, UserStore users, AccountExport export, CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        var json = await export.BuildAsync(user, cancellationToken);
        var bytes = Encoding.UTF8.GetBytes(json.ToJsonString(ExportJson));
        return Results.File(bytes, "application/json", ExportFileName);
    }

    private static async Task<IResult> DeleteAsync(
        [FromBody] DeleteAccountRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        IServerStore servers,
        MongoEnrolKeyStore enrolKeys,
        RefreshTokenStore refreshTokens,
        EmailTokenStore emailTokens,
        AccountExport export,
        IServerLifecycle lifecycle,
        HttpContext http,
        CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        if (!PasswordHasher.Verify(request.Password ?? "", user.PasswordHash))
        {
            return Validation.ValidationProblem("password", "Password is wrong.");
        }

        // Cascade (IMPLEMENTERINGSPLAN 2.2): servers first so agents are disconnected, then everything that points at the user.
        foreach (var server in await servers.ListByOwnersAsync([user.Id], cancellationToken))
        {
            if (await servers.DeleteAsync(server.Id, cancellationToken))
            {
                await lifecycle.ServerRemovedAsync(server.Id, cancellationToken);
            }
        }

        await enrolKeys.DeleteAllForOwnerAsync(user.Id, cancellationToken);
        await export.DeleteOwnedDataAsync(user.Id, cancellationToken);
        await refreshTokens.DeleteAllAsync(user.Id, cancellationToken);
        await emailTokens.DeleteAllAsync(user.Id, cancellationToken);
        await users.DeleteAsync(user.Id, cancellationToken);
        AuthSessions.ClearCookie(http);
        return Results.NoContent();
    }
}
