namespace Glimt.Hub.Infrastructure;

/// <summary>
/// Hardening limits (step 11.2). REST bodies are small (a name, a few tags, alert settings); the largest legitimate
/// request is a push subscription or an alert-settings document, well under 64 KB. The agent's WebSocket frames are
/// bounded separately (<see cref="Features.Agents.AgentSocketOptions"/>). JSON depth caps parser recursion on every
/// deserialiser the hub has: minimal API bodies, SignalR arguments and agent messages.
/// </summary>
public static class RequestLimits
{
    public const long MaxBodyBytes = 1024 * 1024;
    public const int MaxJsonDepth = 32;

    /// <summary>
    /// 413 for any declared body over the limit, before authentication. Kestrel enforces the same limit for chunked
    /// bodies; this middleware makes the rule hold in the in-memory test server as well.
    /// </summary>
    public static IApplicationBuilder UseBodyLimit(this IApplicationBuilder app) =>
        app.Use(async (http, next) =>
        {
            if (http.Request.ContentLength > MaxBodyBytes)
            {
                http.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                return;
            }

            await next(http);
        });
}
