namespace Glimt.Hub.Features.Account;

public static class AccountFeature
{
    public static IServiceCollection AddAccountFeature(this IServiceCollection services)
    {
        // TODO(step 2.3, 2.9): profile, subscription/slots, export, delete.
        return services;
    }

    public static IEndpointRouteBuilder MapAccountFeature(this IEndpointRouteBuilder app)
    {
        // TODO(step 2.3, 2.9): GET/PATCH/DELETE /api/account, GET /api/account/export, GET /api/subscription
        return app;
    }
}
