namespace Glimt.Hub.Features.Groups;

public static class GroupsFeature
{
    public static IServiceCollection AddGroupsFeature(this IServiceCollection services)
    {
        services.AddSingleton<GroupStore>();
        return services;
    }

    public static IEndpointRouteBuilder MapGroupsFeature(this IEndpointRouteBuilder app)
    {
        app.MapGroupsEndpoints();
        return app;
    }
}
