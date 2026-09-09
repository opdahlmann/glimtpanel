namespace Glimt.Hub.Features.Servers;

public static class ServersFeature
{
    public static IServiceCollection AddServersFeature(this IServiceCollection services)
    {
        services.AddSingleton<IServerStore, MongoServerStore>();
        services.AddSingleton<MongoIndexes>();
        services.AddHostedService(sp => sp.GetRequiredService<MongoIndexes>());
        services.AddHostedService<DevSeeder>();
        return services;
    }

    public static IEndpointRouteBuilder MapServersFeature(this IEndpointRouteBuilder app)
    {
        app.MapInstall();
        return app;
    }
}
