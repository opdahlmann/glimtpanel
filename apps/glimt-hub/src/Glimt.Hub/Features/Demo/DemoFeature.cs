using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Demo;

public static class DemoFeature
{
    public static IServiceCollection AddDemoFeature(this IServiceCollection services, GlimtOptions options)
    {
        // TODO(step 2.10): FakeAgentService (GLIMT_DEMO_MODE), demo account, e2e clock and /api/e2e/* triggers.
        return services;
    }

    public static IEndpointRouteBuilder MapDemoFeature(this IEndpointRouteBuilder app)
    {
        return app;
    }
}
