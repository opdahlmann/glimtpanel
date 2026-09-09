using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Buffer;

public static class BufferFeature
{
    public static IServiceCollection AddBufferFeature(this IServiceCollection services, GlimtOptions options)
    {
        services.AddSingleton<BufferStore>();
        services.AddSingleton<BufferPersistence>();
        services.AddHostedService(sp => sp.GetRequiredService<BufferPersistence>());
        return services;
    }

    public static IEndpointRouteBuilder MapBufferFeature(this IEndpointRouteBuilder app)
    {
        app.MapHistory();
        return app;
    }
}
