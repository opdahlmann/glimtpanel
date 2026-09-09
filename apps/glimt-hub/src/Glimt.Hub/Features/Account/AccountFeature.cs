namespace Glimt.Hub.Features.Account;

public static class AccountFeature
{
    public static IServiceCollection AddAccountFeature(this IServiceCollection services)
    {
        services.AddSingleton<AccountExport>();
        return services;
    }

    public static IEndpointRouteBuilder MapAccountFeature(this IEndpointRouteBuilder app)
    {
        app.MapAccountEndpoints();
        return app;
    }
}
