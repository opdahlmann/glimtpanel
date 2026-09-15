using Glimt.Hub.Features.Agents;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Access;
using Glimt.Hub.Infrastructure.Auth;

namespace Glimt.Hub.Features.Buffer;

/// <summary>GET /api/servers/{id}/history?metric=cpu|mem|swap|disk:&lt;path&gt;|net:&lt;iface&gt;|cont:&lt;id&gt;[:mem]&amp;range=1h|24h</summary>
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

                // Access first (step 11.2): a stranger learns nothing about which queries are valid.
                var buffer = store.Get(id);
                if (buffer is null && !registry.TryGet(id, out _))
                {
                    return Results.NotFound();
                }

                if (!await access.CanReadAsync(userId, id, cancellationToken))
                {
                    return Results.StatusCode(StatusCodes.Status403Forbidden);
                }

                if (!HistoryQuery.IsValidMetric(metric))
                {
                    return Results.BadRequest(new { error = "metric must be cpu, mem, swap, disk:<path>, net:<iface>, cont:<id> or cont:<id>:mem" });
                }

                if (!HistoryQuery.TryParseRange(range, out _, out _))
                {
                    return Results.BadRequest(new { error = "range must be 1h or 24h" });
                }

                return Results.Ok(HistoryQuery.Query(buffer, metric, range, clock.GetUtcNow()));
            })
            .RequireAuthorization()
            .RequireRateLimiting(RateLimiting.ApiPolicy);
        return app;
    }
}
