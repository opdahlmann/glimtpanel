using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Live;

public static class LiveFeature
{
    public const string CorsPolicy = "web";

    public static IServiceCollection AddLiveFeature(this IServiceCollection services, GlimtOptions options)
    {
        // JSON is the default for the web app; MessagePack (smaller Card/Server payloads) is negotiated by
        // clients that add the msgpack protocol. Note: MessagePack uses the DTOs' property names as-is.
        services.AddSignalR().AddJsonProtocol(json => json.PayloadSerializerOptions.MaxDepth = RequestLimits.MaxJsonDepth).AddMessagePackProtocol();
        services.AddSingleton<LiveConnections>();
        services.AddSingleton<LivePublisher>();
        services.AddSingleton<ILivePublisher>(sp => sp.GetRequiredService<LivePublisher>());
        services.AddSingleton<ILogReceiver>(sp => sp.GetRequiredService<LivePublisher>());
        services.AddSingleton<IAlertSink, LiveAlertSink>();

        if (WebOrigin(options) is { } origin)
        {
            services.AddCors(cors => cors.AddPolicy(CorsPolicy, policy => policy
                .WithOrigins(origin)
                .AllowAnyHeader()
                .AllowAnyMethod()
                .AllowCredentials()));
        }

        return services;
    }

    /// <summary>The web app proxies /hub in every environment; CORS is only a convenience outside production.</summary>
    public static WebApplication UseLiveCors(this WebApplication app, GlimtOptions options)
    {
        if (WebOrigin(options) is not null)
        {
            app.UseCors(CorsPolicy);
        }

        return app;
    }

    public static IEndpointRouteBuilder MapLiveFeature(this IEndpointRouteBuilder app)
    {
        app.MapHub<LiveHub>(LiveHub.Path);
        return app;
    }

    private static string? WebOrigin(GlimtOptions options)
    {
        if (options.IsProduction || string.IsNullOrWhiteSpace(options.WebPublicUrl))
        {
            return null;
        }

        return Uri.TryCreate(options.WebPublicUrl, UriKind.Absolute, out var uri) ? uri.GetLeftPart(UriPartial.Authority) : null;
    }
}
