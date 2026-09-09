using Glimt.Hub.Infrastructure.Servers;

namespace Glimt.Hub.Infrastructure;

public static class InfrastructureSetup
{
    public static IServiceCollection AddGlimtInfrastructure(this IServiceCollection services, GlimtOptions options)
    {
        services.AddSingleton(options);
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<MongoContext>();
        services.AddHostedService<MongoConnectService>();
        // Replaced by the Agents feature (step 2.5); features are registered after infrastructure, so the last wins.
        services.AddSingleton<IServerLifecycle, NullServerLifecycle>();
        return services;
    }
}
