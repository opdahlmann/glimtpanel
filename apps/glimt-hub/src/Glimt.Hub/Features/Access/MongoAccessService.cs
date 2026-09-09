using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Access;

namespace Glimt.Hub.Features.Access;

/// <summary>
/// Access control from `servers.ownerId` and `accessGrants` (IMPLEMENTERINGSPLAN 4.7, step 2.8). No caching yet.
/// Servers without an owner (enrolled with the dev key) belong to nobody, except outside production where the
/// dev user (GLIMT_DEV_USER_EMAIL) owns them so the walking skeleton keeps working. When the database is
/// unavailable outside production, the in-memory registry is treated as ownerless servers for the same reason.
/// </summary>
public sealed class MongoAccessService(
    IServerStore servers,
    AccessGrantStore grants,
    UserStore users,
    AgentRegistry registry,
    MongoContext mongo,
    GlimtOptions options) : IAccessService
{
    public async Task<IReadOnlyList<string>> VisibleServerIdsAsync(string userId, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return options.IsDevelopmentLike ? registry.All.Select(s => s.ServerId).ToList() : [];
        }

        var ids = new List<string>();
        var received = await grants.ListAcceptedForUserAsync(userId, cancellationToken);
        var ownerIds = received.Select(g => g.OwnerId).Append(userId).Distinct().ToList();
        foreach (var server in await servers.ListByOwnersAsync(ownerIds, cancellationToken))
        {
            if (server.OwnerId == userId || received.Any(g => g.OwnerId == server.OwnerId && g.Covers(server.Tags)))
            {
                ids.Add(server.Id);
            }
        }

        if (await IsDevUserAsync(userId, cancellationToken))
        {
            ids.AddRange((await servers.ListOwnerlessAsync(cancellationToken)).Select(s => s.Id));
        }

        return ids.Distinct().ToList();
    }

    public async Task<bool> CanReadAsync(string userId, string serverId, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return options.IsDevelopmentLike && registry.TryGet(serverId, out _);
        }

        var server = await servers.FindAsync(serverId, cancellationToken);
        if (server is null)
        {
            return false;
        }

        if (server.OwnerId is null)
        {
            return await IsDevUserAsync(userId, cancellationToken);
        }

        if (server.OwnerId == userId)
        {
            return true;
        }

        var received = await grants.ListAcceptedForUserAsync(userId, cancellationToken);
        return received.Any(g => g.OwnerId == server.OwnerId && g.Covers(server.Tags));
    }

    public async Task<bool> IsOwnerAsync(string userId, string serverId, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return options.IsDevelopmentLike && registry.TryGet(serverId, out _);
        }

        var server = await servers.FindAsync(serverId, cancellationToken);
        if (server is null)
        {
            return false;
        }

        return server.OwnerId is null ? await IsDevUserAsync(userId, cancellationToken) : server.OwnerId == userId;
    }

    public async Task<IReadOnlyList<string>> UserIdsWithAccessAsync(string serverId, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return [];
        }

        var server = await servers.FindAsync(serverId, cancellationToken);
        if (server is null)
        {
            return [];
        }

        if (server.OwnerId is null)
        {
            var dev = await DevUserAsync(cancellationToken);
            return dev is null ? [] : [dev.Id];
        }

        var ids = new List<string> { server.OwnerId };
        foreach (var grant in await grants.ListAcceptedByOwnerAsync(server.OwnerId, cancellationToken))
        {
            if (grant.UserId is not null && grant.Covers(server.Tags))
            {
                ids.Add(grant.UserId);
            }
        }

        return ids.Distinct().ToList();
    }

    private async Task<bool> IsDevUserAsync(string userId, CancellationToken cancellationToken)
    {
        if (!options.IsDevelopmentLike || string.IsNullOrWhiteSpace(options.DevUserEmail))
        {
            return false;
        }

        var user = await users.FindByIdAsync(userId, cancellationToken);
        return user is not null && string.Equals(user.Email, options.DevUserEmail.Trim(), StringComparison.OrdinalIgnoreCase);
    }

    private Task<UserDocument?> DevUserAsync(CancellationToken cancellationToken) =>
        options.IsDevelopmentLike && !string.IsNullOrWhiteSpace(options.DevUserEmail)
            ? users.FindByEmailAsync(options.DevUserEmail.Trim().ToLowerInvariant(), cancellationToken)
            : Task.FromResult<UserDocument?>(null);
}
