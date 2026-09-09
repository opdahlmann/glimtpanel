using Glimt.Hub.Infrastructure.Access;

namespace Glimt.Hub.Features.Access;

public static class AccessFeature
{
    public static IServiceCollection AddAccessFeature(this IServiceCollection services)
    {
        // TODO(step 2.8): replace with MongoAccessService (servers.ownerId + accessGrants) and invite endpoints.
        services.AddSingleton<IAccessService, PermissiveAccessService>();
        return services;
    }

    public static IEndpointRouteBuilder MapAccessFeature(this IEndpointRouteBuilder app)
    {
        // TODO(step 2.8): GET/POST/DELETE /api/access, POST /api/access/accept
        return app;
    }
}

/// <summary>Placeholder until step 2.8: every authenticated user owns every server. Never used in production.</summary>
internal sealed class PermissiveAccessService(Agents.AgentRegistry registry) : IAccessService
{
    public Task<IReadOnlyList<string>> VisibleServerIdsAsync(string userId, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<string>>(registry.All.Select(s => s.ServerId).ToList());

    public Task<bool> CanReadAsync(string userId, string serverId, CancellationToken cancellationToken) => Task.FromResult(true);

    public Task<bool> IsOwnerAsync(string userId, string serverId, CancellationToken cancellationToken) => Task.FromResult(true);

    public Task<IReadOnlyList<string>> UserIdsWithAccessAsync(string serverId, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<string>>([]);
}
