using Glimt.Hub.Infrastructure.Access;

namespace Glimt.Hub.Features.Access;

public static class AccessFeature
{
    public static IServiceCollection AddAccessFeature(this IServiceCollection services)
    {
        services.AddSingleton<AccessGrantStore>();
        services.AddSingleton<IAccessService, MongoAccessService>();
        return services;
    }

    public static IEndpointRouteBuilder MapAccessFeature(this IEndpointRouteBuilder app)
    {
        app.MapAccessEndpoints();
        return app;
    }
}
