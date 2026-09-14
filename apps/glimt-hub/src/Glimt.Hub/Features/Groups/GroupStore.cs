using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Groups;

/// <summary>Persistence for `groups`. Every call is a no-op (empty/null/false) when MongoDB is unavailable.</summary>
public sealed class GroupStore(MongoContext mongo, ILogger<GroupStore> logger)
{
    private IMongoCollection<GroupDocument> Groups => mongo.Db.GetCollection<GroupDocument>(GroupDocument.Collection);

    /// <summary>The owner's groups in display order (then by creation).</summary>
    public async Task<IReadOnlyList<GroupDocument>> ListByOwnerAsync(string ownerId, CancellationToken cancellationToken) =>
        mongo.IsAvailable
            ? await Groups.Find(g => g.OwnerId == ownerId).SortBy(g => g.Order).ThenBy(g => g.CreatedAt).ToListAsync(cancellationToken)
            : [];

    public async Task<GroupDocument?> FindAsync(string id, CancellationToken cancellationToken) =>
        mongo.IsAvailable ? await Groups.Find(g => g.Id == id).FirstOrDefaultAsync(cancellationToken) : null;

    public async Task<long> CountByOwnerAsync(string ownerId, CancellationToken cancellationToken) =>
        mongo.IsAvailable ? await Groups.CountDocumentsAsync(g => g.OwnerId == ownerId, cancellationToken: cancellationToken) : 0;

    public async Task InsertAsync(GroupDocument group, CancellationToken cancellationToken)
    {
        if (mongo.IsAvailable)
        {
            await Groups.InsertOneAsync(group, cancellationToken: cancellationToken);
        }
    }

    /// <summary>Replaces the group (same id and owner) and returns it, or null when it is gone.</summary>
    public async Task<GroupDocument?> ReplaceAsync(GroupDocument group, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return null;
        }

        var result = await Groups.ReplaceOneAsync(g => g.Id == group.Id && g.OwnerId == group.OwnerId, group, cancellationToken: cancellationToken);
        return result.MatchedCount > 0 ? group : null;
    }

    public async Task<bool> DeleteAsync(string ownerId, string id, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return false;
        }

        var result = await Groups.DeleteOneAsync(g => g.Id == id && g.OwnerId == ownerId, cancellationToken);
        return result.DeletedCount > 0;
    }

    /// <summary>A node was deleted: it leaves every group (DELETE /api/servers/{id}).</summary>
    public async Task RemoveMemberAsync(string serverId, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return;
        }

        try
        {
            await Groups.UpdateManyAsync(
                Builders<GroupDocument>.Filter.AnyEq(g => g.MemberIds, serverId),
                Builders<GroupDocument>.Update.Pull(g => g.MemberIds, serverId),
                cancellationToken: cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("could not remove {ServerId} from groups: {Error}", serverId, ex.Message);
        }
    }

    /// <summary>Account deletion.</summary>
    public async Task DeleteAllForOwnerAsync(string ownerId, CancellationToken cancellationToken)
    {
        if (mongo.IsAvailable)
        {
            await Groups.DeleteManyAsync(g => g.OwnerId == ownerId, cancellationToken);
        }
    }

    /// <summary>Demo seeding: creates or refreshes a group with a fixed id (members and name), keeping the owner's order.</summary>
    public async Task UpsertSeedAsync(GroupDocument group, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return;
        }

        var update = Builders<GroupDocument>.Update
            .Set(g => g.OwnerId, group.OwnerId)
            .Set(g => g.Name, group.Name)
            .Set(g => g.MemberIds, group.MemberIds)
            .Set(g => g.UpdatedAt, group.UpdatedAt)
            .SetOnInsert(g => g.Order, group.Order)
            .SetOnInsert(g => g.CreatedAt, group.CreatedAt);
        await Groups.UpdateOneAsync(g => g.Id == group.Id, update, new UpdateOptions { IsUpsert = true }, cancellationToken);
    }
}
