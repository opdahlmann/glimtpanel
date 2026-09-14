using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Health;

/// <summary>What the web app's global error handler sends (step 9.5). Everything is optional and truncated.</summary>
public sealed record ClientErrorRequest(string? Message, string? Stack, string? Url, string? UserAgent, string? Version);

/// <summary>
/// POST /api/client-errors: uncaught errors in the browser land in the hub log so they can be seen in Dokploy.
/// Anonymous (errors happen before login too), rate-limited per address, never stored.
/// </summary>
public static class ClientErrorsEndpoint
{
    public const string Path = "/api/client-errors";
    public const int MaxMessage = 500;
    public const int MaxStack = 4000;

    public static IEndpointRouteBuilder MapClientErrors(this IEndpointRouteBuilder app)
    {
        app.MapPost(Path, (ClientErrorRequest request, HttpContext http, ILoggerFactory loggers) =>
            {
                var logger = loggers.CreateLogger("Glimt.Hub.ClientErrors");
                logger.LogWarning(
                    "client error from {Remote}: {Message} at {Url} ({UserAgent}, web {Version})\n{Stack}",
                    http.Connection.RemoteIpAddress,
                    Cut(request.Message, MaxMessage) ?? "(no message)",
                    Cut(request.Url, 300),
                    Cut(request.UserAgent, 200),
                    Cut(request.Version, 40),
                    Cut(request.Stack, MaxStack));
                return Results.NoContent();
            })
            .RequireRateLimiting(RateLimiting.ErrorsPolicy);
        return app;
    }

    private static string? Cut(string? value, int max) => value is null ? null : value.Length <= max ? value : value[..max] + "…";
}
