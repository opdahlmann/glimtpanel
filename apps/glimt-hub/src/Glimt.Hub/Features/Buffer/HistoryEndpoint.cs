using Glimt.Hub.Features.Agents;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Access;
using Glimt.Hub.Infrastructure.Auth;

namespace Glimt.Hub.Features.Buffer;

/// <summary>GET /api/servers/{id}/history?metric=cpu|mem|swap|disk:&lt;path&gt;|net:&lt;iface&gt;|cont:&lt;id&gt;&amp;range=1h|24h</summary>
public static class HistoryEndpoint
{
    public const string Path = "/api/servers/{id}/history";

    public static IEndpointRouteBuilder MapHistory(this IEndpointRouteBuilder app)
    {
        app.MapGet(Path, async (string id, string? metric, string? range, HttpContext http, AgentRegistry registry, BufferStore store, IAccessService access, TimeProvider clock, CancellationToken cancellationToken) =>
            {
                var userId = http.User.GetUserId();
                if (userId is null)
                {
                    return Results.Unauthorized();
                }

                if (!HistoryQuery.IsValidMetric(metric))
                {
                    return Results.BadRequest(new { error = "metric must be cpu, mem, swap, disk:<path>, net:<iface> or cont:<id>" });
                }

                if (!HistoryQuery.TryParseRange(range, out _, out _))
                {
                    return Results.BadRequest(new { error = "range must be 1h or 24h" });
                }

                var buffer = store.Get(id);
                if (buffer is null && !registry.TryGet(id, out _))
                {
                    return Results.NotFound();
                }

                if (!await access.CanReadAsync(userId, id, cancellationToken))
                {
                    return Results.StatusCode(StatusCodes.Status403Forbidden);
                }

                return Results.Ok(HistoryQuery.Query(buffer, metric, range, clock.GetUtcNow()));
            })
            .RequireAuthorization()
            .RequireRateLimiting(RateLimiting.ApiPolicy);
        return app;
    }
}
