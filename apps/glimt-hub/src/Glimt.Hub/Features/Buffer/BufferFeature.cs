using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Buffer;

public static class BufferFeature
{
    public static IServiceCollection AddBufferFeature(this IServiceCollection services, GlimtOptions options)
    {
        // TODO(step 2.6): ring buffer per server (2 880 points), persistence to GLIMT_BUFFER_PATH, history queries.
        return services;
    }

    public static IEndpointRouteBuilder MapBufferFeature(this IEndpointRouteBuilder app)
    {
        // TODO(step 2.6): GET /api/servers/{id}/history?metric=&range=1h|24h
        return app;
    }
}
