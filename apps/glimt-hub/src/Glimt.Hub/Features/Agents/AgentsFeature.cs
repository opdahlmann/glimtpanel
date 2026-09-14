using Glimt.Hub.Infrastructure.Servers;

namespace Glimt.Hub.Features.Agents;

public static class AgentsFeature
{
    public const string WebSocketPath = "/agent/ws";

    public static IServiceCollection AddAgentsFeature(this IServiceCollection services)
    {
        services.AddSingleton<AgentRegistry>();
        services.AddSingleton<UserDirectory>();
        services.AddSingleton<AgentAuthenticator>();
        services.AddSingleton<AgentIngest>();
        services.AddSingleton<SubscriptionCounter>();
        services.AddSingleton<LogRelay>();
        services.AddSingleton<NodeLinker>();
        services.AddSingleton<IServerLifecycle, AgentLifecycle>();
        services.AddTransient<AgentConnection>();
        services.AddSingleton<DownDetector>();
        services.AddHostedService(sp => sp.GetRequiredService<DownDetector>());
        return services;
    }

    public static WebApplication MapAgentsFeature(this WebApplication app)
    {
        app.UseWebSockets();
        app.MapGet(WebSocketPath, HandleAsync);
        app.MapSnapshot();
        return app;
    }

    private static async Task HandleAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status426UpgradeRequired;
            await context.Response.WriteAsync("WebSocket upgrade required");
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        var connection = context.RequestServices.GetRequiredService<AgentConnection>();
        var remote = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        await connection.RunAsync(socket, remote, context.RequestAborted);
    }
}
