using System.Security.Claims;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Access;
using Glimt.Hub.Infrastructure.Auth;
using Glimt.Hub.Infrastructure.Servers;

namespace Glimt.Hub.Features.Servers;

/// <summary>/api/servers (IMPLEMENTERINGSPLAN 4.3, step 2.4). Snapshot and history belong to the Buffer feature.</summary>
public static class ServersEndpoints
{
    public const string UninstallCommand = "sudo /usr/local/bin/glimt-agent uninstall";
    public static readonly TimeSpan PreviousTokenOverlap = TimeSpan.FromMinutes(10);

    public static IEndpointRouteBuilder MapServersEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/servers")
            .RequireAuthorization()
            .RequireRateLimiting(RateLimiting.ApiPolicy)
            .AddEndpointFilter<RequireDatabase>();
        group.MapPost("/enrol-key", CreateEnrolKeyAsync);
        group.MapGet("", ListAsync);
        group.MapGet("/{id}", GetAsync);
        group.MapPatch("/{id}", PatchAsync);
        group.MapDelete("/{id}", DeleteAsync);
        group.MapPost("/{id}/rotate-key", RotateKeyAsync);
        return app;
    }

    internal static string EnrolCommand(GlimtOptions options, string key, string dockerMode)
    {
        var installUrl = options.InstallUrl ?? (options.HubPublicUrl ?? options.HubUrl).TrimEnd('/') + InstallEndpoint.Path;
        return $"curl -fsSL {installUrl} | sh -s -- --key {key} --docker {dockerMode}";
    }

    private static async Task<IResult> CreateEnrolKeyAsync(
        EnrolKeyRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        MongoEnrolKeyStore keys,
        GlimtOptions options,
        CancellationToken cancellationToken)
    {
        var dockerMode = request.DockerMode?.Trim().ToLowerInvariant();
        if (!DockerModes.IsValid(dockerMode))
        {
            return Validation.ValidationProblem("dockerMode", "dockerMode must be proxy, simple or none.");
        }

        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        if (user.EmailConfirmedAt is null)
        {
            return Validation.Forbidden("Confirm your e-mail before adding servers", AuthEndpoints.EmailNotConfirmed);
        }

        var (key, expiresAt) = await keys.CreateAsync(user.Id, dockerMode!, cancellationToken);
        return Results.Ok(new EnrolKeyResponse(key, EnrolCommand(options, key, dockerMode!), new DateTimeOffset(DateTime.SpecifyKind(expiresAt, DateTimeKind.Utc)), dockerMode!));
    }

    private static async Task<IResult> ListAsync(
        ClaimsPrincipal principal,
        IAccessService access,
        IServerStore servers,
        UserStore users,
        AgentRegistry registry,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var userId = principal.RequireUserId();
        var ids = await access.VisibleServerIdsAsync(userId, cancellationToken);
        var docs = await servers.ListByIdsAsync(ids, cancellationToken);
        var owners = await users.FindByIdsAsync(docs.Where(d => d.OwnerId is not null && d.OwnerId != userId).Select(d => d.OwnerId!), cancellationToken);
        var ownerEmails = owners.ToDictionary(o => o.Id, o => o.Email);
        var today = DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime);
        var list = docs.Select(doc => Project(doc, userId, ownerEmails, registry, today)).ToList();
        return Results.Ok(list);
    }

    private static async Task<IResult> GetAsync(
        string id,
        ClaimsPrincipal principal,
        IAccessService access,
        IServerStore servers,
        UserStore users,
        AgentRegistry registry,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var userId = principal.RequireUserId();
        if (!await access.CanReadAsync(userId, id, cancellationToken))
        {
            return Validation.Forbidden("No access to this server");
        }

        var doc = await servers.FindAsync(id, cancellationToken);
        if (doc is null)
        {
            return Validation.NotFound("Server not found");
        }

        var ownerEmails = new Dictionary<string, string>();
        if (doc.OwnerId is not null && doc.OwnerId != userId && await users.FindByIdAsync(doc.OwnerId, cancellationToken) is { } owner)
        {
            ownerEmails[owner.Id] = owner.Email;
        }

        return Results.Ok(Project(doc, userId, ownerEmails, registry, DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime)));
    }

    private static async Task<IResult> PatchAsync(
        string id,
        PatchServerRequest request,
        ClaimsPrincipal principal,
        IAccessService access,
        IServerStore servers,
        AgentRegistry registry,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var userId = principal.RequireUserId();
        if (!await access.IsOwnerAsync(userId, id, cancellationToken))
        {
            return Validation.Forbidden("Only the owner can change a server");
        }

        var errors = new Dictionary<string, string[]>();
        string? name = null;
        if (request.Name is not null)
        {
            name = ServerTags.NormalizeName(request.Name);
            if (name is null)
            {
                errors["name"] = [$"Name must be 1–{ServerTags.NameMaxLength} characters."];
            }
        }

        IReadOnlyList<string>? tags = null;
        if (request.Tags is not null)
        {
            tags = ServerTags.Normalize(request.Tags, out var tagError);
            if (tags is null)
            {
                errors["tags"] = [tagError!];
            }
        }

        if (errors.Count > 0)
        {
            return Validation.ValidationProblem(errors);
        }

        var doc = await servers.UpdateNameTagsAsync(id, name, tags, cancellationToken);
        if (doc is null)
        {
            return Validation.NotFound("Server not found");
        }

        return Results.Ok(Project(doc, userId, new Dictionary<string, string>(), registry, DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime)));
    }

    private static async Task<IResult> DeleteAsync(
        string id,
        ClaimsPrincipal principal,
        IAccessService access,
        IServerStore servers,
        IServerLifecycle lifecycle,
        CancellationToken cancellationToken)
    {
        if (!await access.IsOwnerAsync(principal.RequireUserId(), id, cancellationToken))
        {
            return Validation.Forbidden("Only the owner can delete a server");
        }

        if (!await servers.DeleteAsync(id, cancellationToken))
        {
            return Validation.NotFound("Server not found");
        }

        await lifecycle.ServerRemovedAsync(id, cancellationToken);
        return Results.Ok(new DeleteServerResponse(UninstallCommand));
    }

    private static async Task<IResult> RotateKeyAsync(
        string id,
        ClaimsPrincipal principal,
        IAccessService access,
        IServerStore servers,
        IServerLifecycle lifecycle,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        if (!await access.IsOwnerAsync(principal.RequireUserId(), id, cancellationToken))
        {
            return Validation.Forbidden("Only the owner can rotate the key");
        }

        var token = AgentTokens.Generate();
        var hash = AgentTokens.Hash(token);
        var validUntil = clock.GetUtcNow().Add(PreviousTokenOverlap).UtcDateTime;
        if (!await servers.RotateTokenAsync(id, hash, validUntil, cancellationToken))
        {
            return Validation.NotFound("Server not found");
        }

        // The agent gets the token over its socket (or at its next hello); it is never returned to the browser.
        await lifecycle.TokenRotatedAsync(id, token, hash, cancellationToken);
        return Results.NoContent();
    }

    private static ServerDto Project(ServerDocument doc, string userId, IReadOnlyDictionary<string, string> ownerEmails, AgentRegistry registry, DateOnly today)
    {
        var isOwner = doc.OwnerId is null || doc.OwnerId == userId;
        var ownerEmail = !isOwner && ownerEmails.TryGetValue(doc.OwnerId!, out var email) ? email : null;
        var live = registry.TryGet(doc.Id, out var session) ? session : null;
        return ServerDto.From(doc, isOwner ? ServerRoles.Owner : ServerRoles.Reader, ownerEmail, live, today);
    }
}
