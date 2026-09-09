using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Access;

/// <summary>Persistence for `accessGrants`. Used by the Access endpoints, <see cref="MongoAccessService"/>, Auth (register hook) and Account (export/delete).</summary>
public sealed class AccessGrantStore(MongoContext mongo)
{
    private IMongoCollection<AccessGrantDocument> Grants => mongo.Db.GetCollection<AccessGrantDocument>(AccessGrantDocument.Collection);

    /// <summary>Inserts the grant; false when the owner already has a grant for that e-mail.</summary>
    public async Task<bool> TryInsertAsync(AccessGrantDocument grant, CancellationToken cancellationToken)
    {
        try
        {
            await Grants.InsertOneAsync(grant, cancellationToken: cancellationToken);
            return true;
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            return false;
        }
    }

    public Task<AccessGrantDocument?> FindAsync(string id, CancellationToken cancellationToken) =>
        Grants.Find(g => g.Id == id).FirstOrDefaultAsync(cancellationToken)!;

    public Task<AccessGrantDocument?> FindByInviteTokenAsync(string token, CancellationToken cancellationToken)
    {
        var hash = Auth.Tokens.Hash(token);
        return Grants.Find(g => g.InviteTokenHash == hash && g.Status == GrantStatuses.Pending).FirstOrDefaultAsync(cancellationToken)!;
    }

    /// <summary>Grants given by the owner, newest first.</summary>
    public Task<List<AccessGrantDocument>> ListByOwnerAsync(string ownerId, CancellationToken cancellationToken) =>
        Grants.Find(g => g.OwnerId == ownerId).SortByDescending(g => g.CreatedAt).ToListAsync(cancellationToken);

    /// <summary>Accepted grants received by the user (the servers of those owners are visible).</summary>
    public Task<List<AccessGrantDocument>> ListAcceptedForUserAsync(string userId, CancellationToken cancellationToken) =>
        Grants.Find(g => g.UserId == userId && g.Status == GrantStatuses.Accepted).ToListAsync(cancellationToken);

    /// <summary>All grants where the user is the invitee (any status), for export.</summary>
    public Task<List<AccessGrantDocument>> ListReceivedAsync(string userId, CancellationToken cancellationToken) =>
        Grants.Find(g => g.UserId == userId).ToListAsync(cancellationToken);

    public Task<List<AccessGrantDocument>> ListAcceptedByOwnerAsync(string ownerId, CancellationToken cancellationToken) =>
        Grants.Find(g => g.OwnerId == ownerId && g.Status == GrantStatuses.Accepted && g.UserId != null).ToListAsync(cancellationToken);

    public async Task<bool> DeleteAsync(string ownerId, string id, CancellationToken cancellationToken)
    {
        var result = await Grants.DeleteOneAsync(g => g.Id == id && g.OwnerId == ownerId, cancellationToken);
        return result.DeletedCount > 0;
    }

    /// <summary>Links every pending grant for the e-mail to the new account (register hook). Returns how many were linked.</summary>
    public async Task<long> LinkPendingAsync(string email, string userId, DateTime now, CancellationToken cancellationToken)
    {
        var result = await Grants.UpdateManyAsync(
            g => g.Email == email && g.UserId == null,
            Builders<AccessGrantDocument>.Update
                .Set(g => g.UserId, userId)
                .Set(g => g.Status, GrantStatuses.Accepted)
                .Set(g => g.AcceptedAt, now)
                .Unset(g => g.InviteTokenHash),
            cancellationToken: cancellationToken);
        return result.ModifiedCount;
    }

    public async Task<AccessGrantDocument?> AcceptAsync(string id, string userId, DateTime now, CancellationToken cancellationToken) =>
        await Grants.FindOneAndUpdateAsync(
            g => g.Id == id && g.Status == GrantStatuses.Pending,
            Builders<AccessGrantDocument>.Update
                .Set(g => g.UserId, userId)
                .Set(g => g.Status, GrantStatuses.Accepted)
                .Set(g => g.AcceptedAt, now)
                .Unset(g => g.InviteTokenHash),
            new FindOneAndUpdateOptions<AccessGrantDocument> { ReturnDocument = ReturnDocument.After },
            cancellationToken);

    /// <summary>Removes grants given by and received by the user (account deletion).</summary>
    public Task DeleteAllForUserAsync(string userId, CancellationToken cancellationToken) =>
        Grants.DeleteManyAsync(g => g.OwnerId == userId || g.UserId == userId, cancellationToken);
}
