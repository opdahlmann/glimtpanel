using System.Security.Claims;
using System.Text.Json;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Auth;
using Glimt.Hub.Infrastructure.Email;

namespace Glimt.Hub.Features.Access;

public sealed record CreateGrantRequest(string? Email, JsonElement? Scope);

/// <summary>A grant as the owner sees it. Scope is "all" or an array of tags.</summary>
public sealed record GrantDto(string Id, string Email, object Scope, string Status, DateTimeOffset CreatedAt, string Initials)
{
    public static GrantDto From(AccessGrantDocument grant, string? name) =>
        new(grant.Id, grant.Email, ScopeValue(grant), grant.Status, new DateTimeOffset(DateTime.SpecifyKind(grant.CreatedAt, DateTimeKind.Utc)), Validation.Initials(name, grant.Email));

    public static object ScopeValue(AccessGrantDocument grant) => grant.Scope == GrantScopes.All ? GrantScopes.All : grant.Tags.ToArray();
}

/// <summary>A grant as the reader sees it after accepting.</summary>
public sealed record AcceptedGrantDto(string Id, string OwnerEmail, string OwnerName, object Scope, string Status);

/// <summary>/api/access (IMPLEMENTERINGSPLAN 4.3, step 2.8).</summary>
public static class AccessEndpoints
{
    public static IEndpointRouteBuilder MapAccessEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/access")
            .RequireAuthorization()
            .RequireRateLimiting(RateLimiting.ApiPolicy)
            .AddEndpointFilter<RequireDatabase>();
        group.MapPost("", CreateAsync);
        group.MapGet("", ListAsync);
        group.MapDelete("/{id}", DeleteAsync);
        group.MapPost("/accept", AcceptAsync);
        return app;
    }

    private static async Task<IResult> CreateAsync(
        CreateGrantRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        AccessGrantStore grants,
        AuthSessions sessions,
        IEmailSender mail,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var errors = new Dictionary<string, string[]>();
        var email = Validation.NormalizeEmail(request.Email);
        if (email is null)
        {
            errors["email"] = ["Enter a valid e-mail address."];
        }

        var (scope, tags, scopeError) = ParseScope(request.Scope);
        if (scopeError is not null)
        {
            errors["scope"] = [scopeError];
        }

        if (errors.Count > 0)
        {
            return Validation.ValidationProblem(errors);
        }

        var owner = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (owner is null)
        {
            return Validation.Unauthorized();
        }

        if (email == owner.Email)
        {
            return Validation.ValidationProblem("email", "You already have access to your own servers.");
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var invitee = await users.FindByEmailAsync(email!, cancellationToken);
        var inviteToken = invitee is null ? Tokens.Generate() : null;
        var grant = new AccessGrantDocument
        {
            OwnerId = owner.Id,
            Email = email!,
            UserId = invitee?.Id,
            Scope = scope!,
            Tags = tags!.ToList(),
            Status = invitee is null ? GrantStatuses.Pending : GrantStatuses.Accepted,
            InviteTokenHash = inviteToken is null ? null : Tokens.Hash(inviteToken),
            CreatedAt = now,
            AcceptedAt = invitee is null ? null : now,
        };
        if (!await grants.TryInsertAsync(grant, cancellationToken))
        {
            return Validation.Problem(StatusCodes.Status409Conflict, "That e-mail already has access", code: "grantExists");
        }

        var message = invitee is null
            ? EmailTemplates.Invite(email!, owner.Language, owner.Name, sessions.WebLink("/access/accept", inviteToken))
            : EmailTemplates.AccessGranted(email!, invitee.Language, owner.Name, sessions.WebLink("/"));
        await mail.SendAsync(message, cancellationToken);
        return Results.Created($"/api/access/{grant.Id}", GrantDto.From(grant, invitee?.Name));
    }

    private static async Task<IResult> ListAsync(ClaimsPrincipal principal, UserStore users, AccessGrantStore grants, CancellationToken cancellationToken)
    {
        var list = await grants.ListByOwnerAsync(principal.RequireUserId(), cancellationToken);
        var names = (await users.FindByIdsAsync(list.Where(g => g.UserId is not null).Select(g => g.UserId!), cancellationToken))
            .ToDictionary(u => u.Id, u => u.Name);
        return Results.Ok(list.Select(g => GrantDto.From(g, g.UserId is not null && names.TryGetValue(g.UserId, out var name) ? name : null)).ToList());
    }

    private static async Task<IResult> DeleteAsync(string id, ClaimsPrincipal principal, AccessGrantStore grants, CancellationToken cancellationToken) =>
        await grants.DeleteAsync(principal.RequireUserId(), id, cancellationToken) ? Results.NoContent() : Validation.NotFound("Grant not found");

    private static async Task<IResult> AcceptAsync(
        TokenRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        AccessGrantStore grants,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var grant = string.IsNullOrWhiteSpace(request.Token) ? null : await grants.FindByInviteTokenAsync(request.Token.Trim(), cancellationToken);
        if (grant is null)
        {
            return Validation.Problem(StatusCodes.Status400BadRequest, "Invalid or used invitation", code: "invalidToken");
        }

        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        if (!string.Equals(user.Email, grant.Email, StringComparison.Ordinal))
        {
            return Validation.Forbidden("This invitation was sent to another e-mail address", "emailMismatch");
        }

        var accepted = await grants.AcceptAsync(grant.Id, user.Id, clock.GetUtcNow().UtcDateTime, cancellationToken);
        if (accepted is null)
        {
            return Validation.Problem(StatusCodes.Status400BadRequest, "Invalid or used invitation", code: "invalidToken");
        }

        var owner = await users.FindByIdAsync(accepted.OwnerId, cancellationToken);
        return Results.Ok(new AcceptedGrantDto(accepted.Id, owner?.Email ?? "", owner?.Name ?? "", GrantDto.ScopeValue(accepted), accepted.Status));
    }

    /// <summary>scope is the string "all" or an array of tags (same rules as server tags, at least one).</summary>
    internal static (string? Scope, IReadOnlyList<string>? Tags, string? Error) ParseScope(JsonElement? scope)
    {
        if (scope is not { } element || element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return (null, null, "scope must be \"all\" or a list of tags.");
        }

        if (element.ValueKind == JsonValueKind.String)
        {
            return string.Equals(element.GetString(), GrantScopes.All, StringComparison.OrdinalIgnoreCase)
                ? (GrantScopes.All, [], null)
                : (null, null, "scope must be \"all\" or a list of tags.");
        }

        if (element.ValueKind != JsonValueKind.Array)
        {
            return (null, null, "scope must be \"all\" or a list of tags.");
        }

        var raw = new List<string?>();
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                return (null, null, "scope tags must be strings.");
            }

            raw.Add(item.GetString());
        }

        if (raw.Count == 0)
        {
            return (null, null, "scope needs at least one tag (or \"all\").");
        }

        var tags = ServerTags.Normalize(raw, out var error);
        return tags is null ? (null, null, error) : (GrantScopes.Tags, tags, null);
    }
}
