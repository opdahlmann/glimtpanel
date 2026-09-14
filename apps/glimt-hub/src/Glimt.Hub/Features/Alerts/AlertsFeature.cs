using Glimt.Hub.Features.Alerts.Channels;
using Glimt.Hub.Features.Alerts.Push;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Alerts;

public static class AlertsFeature
{
    public static IServiceCollection AddAlertsFeature(this IServiceCollection services)
    {
        services.AddSingleton<IAlertStore, MongoAlertStore>();
        services.AddSingleton<AlertConfigProvider>();
        services.AddSingleton<ActiveAlertCounts>();
        services.AddSingleton<AlertEngine>();
        services.AddHostedService<AlertEngineService>();

        services.AddHttpClient(WebPushClient.ClientName, client => client.Timeout = WebPushClient.Timeout);
        services.AddHttpClient(WebhookChannel.ClientName, client => client.Timeout = WebhookChannel.Timeout);
        services.AddSingleton<IWebPushClient, WebPushClient>();
        services.AddSingleton<PushChannel>();
        services.AddSingleton<EmailChannel>();
        services.AddSingleton<WebhookChannel>();
        services.AddSingleton<IChannel>(sp => sp.GetRequiredService<PushChannel>());
        services.AddSingleton<IChannel>(sp => sp.GetRequiredService<EmailChannel>());
        services.AddSingleton<IChannel>(sp => sp.GetRequiredService<WebhookChannel>());
        services.AddSingleton<NotificationDispatcher>();
        services.AddSingleton<IAlertSink>(sp => sp.GetRequiredService<NotificationDispatcher>());
        services.AddHostedService<DigestService>();
        return services;
    }

    public static IEndpointRouteBuilder MapAlertsFeature(this IEndpointRouteBuilder app)
    {
        app.MapAlertEndpoints();
        var options = app.ServiceProvider.GetRequiredService<GlimtOptions>();
        var log = app.ServiceProvider.GetRequiredService<ILoggerFactory>().CreateLogger("Glimt.Hub.Features.Alerts");
        if (!app.ServiceProvider.GetRequiredService<IWebPushClient>().IsConfigured)
        {
            log.LogWarning("Web Push is off: GLIMT_VAPID_PUBLIC/GLIMT_VAPID_PRIVATE are not set (dotnet run -- vapid-keys). Env: {Env}", options.Env);
        }

        return app;
    }
}
