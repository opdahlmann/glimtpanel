namespace Glimt.Hub.Infrastructure;

public static class InfrastructureSetup
{
    public static IServiceCollection AddGlimtInfrastructure(this IServiceCollection services, GlimtOptions options)
    {
        services.AddSingleton(options);
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<MongoContext>();
        services.AddHostedService<MongoConnectService>();
        return services;
    }
}
