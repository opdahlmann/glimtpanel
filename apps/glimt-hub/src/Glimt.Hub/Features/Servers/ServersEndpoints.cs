using System.Security.Claims;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;
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
    public const string RemoveSidecarHint = "remove the sidecar from your compose file";
    public static readonly TimeSpan PreviousTokenOverlap = TimeSpan.FromMinutes(10);

    public static IEndpointRouteBuilder MapServersEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/servers")
            .RequireAuthorization()
            .RequireRateLimiting(RateLimiting.ApiPolicy)
            .AddEndpointFilter<RequireDatabase>();
        group.MapPost("/enrol-key", CreateEnrolKeyAsync);
        group.MapPost("", CreateNodeAsync);
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

    /// <summary>
    /// Creates a container node at once (step 12.5): the long-lived token is returned exactly once with the compose
    /// and Dockerfile snippets. The node is down with no last-seen until its first hello.
    /// </summary>
    private static async Task<IResult> CreateNodeAsync(
        CreateNodeRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        IServerStore servers,
        AgentRegistry registry,
        ILivePublisher live,
        GlimtOptions options,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        if (NodeKinds.Normalize(request.Kind) != NodeKinds.Container || request.Kind is null)
        {
            return Validation.ValidationProblem("kind", "kind must be container; servers are added with an enrol key.");
        }

        var name = ServerTags.NormalizeName(request.Name);
        if (name is null)
        {
            return Validation.ValidationProblem("name", $"Name must be 1–{ServerTags.NameMaxLength} characters.");
        }

        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        if (user.EmailConfirmedAt is null)
        {
            return Validation.Forbidden("Confirm your e-mail before adding nodes", AuthEndpoints.EmailNotConfirmed);
        }

        var token = AgentTokens.Generate();
        var now = clock.GetUtcNow();
        var doc = new ServerDocument
        {
            Id = ServerIds.New(),
            OwnerId = user.Id,
            Hostname = name,
            Name = name,
            Kind = NodeKinds.Container,
            TokenHash = AgentTokens.Hash(token),
            Status = ServerStatuses.Down,
            CreatedAt = now.UtcDateTime,
        };
        await servers.InsertAsync(doc, cancellationToken);

        // The registry knows the node from now on, so the token resumes without a store lookup and the overview shows the card (down).
        var session = registry.GetOrAdd(doc.Id);
        session.Restore(doc);
        await live.ServerAddedAsync(session, cancellationToken);

        var hubWs = ContainerSnippets.AgentWsUrl(options);
        var image = ContainerSnippets.Image(options);
        return Results.Ok(new CreateNodeResponse(
            doc.Id,
            name,
            NodeKinds.Container,
            token,
            hubWs,
            image,
            ContainerSnippets.Compose(image, hubWs, token, name),
            ContainerSnippets.Dockerfile(image, hubWs, token, name)));
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
        ILivePublisher live,
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

        // The live session carries name and tags into every Card/ServerStatus; tell it, and push a fresh Card to the browsers.
        if (registry.TryGet(id, out var session))
        {
            session.SetIdentity(doc.Name, doc.Tags);
            await live.StatusAsync(session, cancellationToken);
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

        var doc = await servers.FindAsync(id, cancellationToken);
        if (doc is null || !await servers.DeleteAsync(id, cancellationToken))
        {
            return Validation.NotFound("Server not found");
        }

        await lifecycle.ServerRemovedAsync(id, cancellationToken);
        var kind = NodeKinds.Normalize(doc.Kind);
        return kind == NodeKinds.Container
            ? Results.Ok(new DeleteServerResponse(null, kind, RemoveSidecarHint))
            : Results.Ok(new DeleteServerResponse(UninstallCommand, kind));
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

        var doc = await servers.FindAsync(id, cancellationToken);
        if (doc is null)
        {
            return Validation.NotFound("Server not found");
        }

        var isContainer = NodeKinds.Normalize(doc.Kind) == NodeKinds.Container;
        var token = AgentTokens.Generate();
        var hash = AgentTokens.Hash(token);
        var validUntil = clock.GetUtcNow().Add(isContainer ? AgentLifecycle.ContainerTokenOverlap : PreviousTokenOverlap);
        if (!await servers.RotateTokenAsync(id, hash, validUntil.UtcDateTime, cancellationToken))
        {
            return Validation.NotFound("Server not found");
        }

        await lifecycle.TokenRotatedAsync(id, token, hash, cancellationToken);
        if (isContainer)
        {
            // A container node reads GLIMT_TOKEN at start: the owner gets the token once and has 24 h to update the environment (step 12.5).
            return Results.Ok(new RotateKeyResponse(token, validUntil));
        }

        // A server's agent gets the token over its socket (or at its next hello); it is never returned to the browser.
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
