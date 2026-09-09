namespace Glimt.Hub.Features.Servers;

public static class ServersFeature
{
    public static IServiceCollection AddServersFeature(this IServiceCollection services)
    {
        services.AddSingleton<IServerStore, MongoServerStore>();
        // TODO(step 2.4): MongoEnrolKeyStore (collection enrolKeys, TTL index on expiresAt).
        services.AddSingleton<IEnrolKeyStore, NullEnrolKeyStore>();
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
