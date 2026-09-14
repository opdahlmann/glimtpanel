using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Access;
using Glimt.Hub.Infrastructure.Auth;

namespace Glimt.Hub.Features.Agents;

/// <summary>GET /api/servers/{id}/snapshot: the last snapshot merged with the last stream as the Server projection.</summary>
public static class SnapshotEndpoint
{
    public const string Path = "/api/servers/{id}/snapshot";

    public static IEndpointRouteBuilder MapSnapshot(this IEndpointRouteBuilder app)
    {
        app.MapGet(Path, async (string id, HttpContext http, AgentRegistry registry, NodeLinker linker, TimeProvider clock, IAccessService access, CancellationToken cancellationToken) =>
            {
                var userId = http.User.GetUserId();
                if (userId is null)
                {
                    return Results.Unauthorized();
                }

                if (!registry.TryGet(id, out var session))
                {
                    return Results.NotFound();
                }

                if (!await access.CanReadAsync(userId, id, cancellationToken))
                {
                    return Results.StatusCode(StatusCodes.Status403Forbidden);
                }

                if (session.LastSnapshot is null && session.LastStream is null)
                {
                    return Results.NoContent();
                }

                return Results.Ok(Projections.Server(session, linker, clock.GetUtcNow()));
            })
            .RequireAuthorization()
            .RequireRateLimiting(RateLimiting.ApiPolicy);
        return app;
    }
}
