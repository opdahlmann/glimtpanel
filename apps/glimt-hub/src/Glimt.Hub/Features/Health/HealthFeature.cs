using System.Diagnostics;
using System.Reflection;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Buffer;
using Glimt.Hub.Features.Demo;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Health;

public sealed record BufferHealth(int Servers, long Points, string? LastSavedAt);

public sealed record HealthResponse(string Status, string Version, string Env, string Mongo, int AgentsConnected, long UptimeSec, bool DemoMode, BufferHealth Buffer);

public static class HealthFeature
{
    public const string Path = "/healthz";

    public static readonly string Version =
        typeof(HealthFeature).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";

    private static readonly DateTime StartedAt = Process.GetCurrentProcess().StartTime.ToUniversalTime();

    public static IEndpointRouteBuilder MapHealthFeature(this IEndpointRouteBuilder app)
    {
        app.MapGet(Path, (GlimtOptions options, MongoContext mongo, AgentRegistry registry, BufferStore buffers) => Results.Ok(new HealthResponse(
            "ok",
            Version,
            options.Env,
            mongo.IsAvailable ? "ok" : "unavailable",
            registry.ConnectedCount,
            (long)(DateTime.UtcNow - StartedAt).TotalSeconds,
            DemoFeature.IsDemoMode(options),
            new BufferHealth(buffers.ServerCount, buffers.TotalPoints, buffers.LastSavedAt?.UtcDateTime.ToString("o")))));
        return app;
    }
}
