using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Infrastructure;
using MongoDB.Bson;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Servers;

/// <summary>Persistence for the `servers` collection. Every call is a no-op (null/empty/false) when MongoDB is unavailable.</summary>
public interface IServerStore
{
    Task<ServerDocument?> FindByTokenHashAsync(string tokenHash, CancellationToken cancellationToken);

    /// <summary>Inserts or updates the server; createdAt and ownerId are only set on insert.</summary>
    Task UpsertAsync(ServerDocument doc, CancellationToken cancellationToken);

    /// <summary>Inserts a new document as is (container nodes from POST /api/servers, step 12.5).</summary>
    Task InsertAsync(ServerDocument doc, CancellationToken cancellationToken);

    Task TouchAsync(string serverId, DateTime? lastSeenAt, string status, CancellationToken cancellationToken);

    Task<ServerDocument?> FindAsync(string serverId, CancellationToken cancellationToken);

    Task<IReadOnlyList<ServerDocument>> ListByIdsAsync(IEnumerable<string> serverIds, CancellationToken cancellationToken);

    Task<IReadOnlyList<ServerDocument>> ListByOwnersAsync(IEnumerable<string> ownerIds, CancellationToken cancellationToken);

    /// <summary>Servers enrolled without an owner (dev key before step 2.4). Only meaningful outside production.</summary>
    Task<IReadOnlyList<ServerDocument>> ListOwnerlessAsync(CancellationToken cancellationToken);

    Task<long> CountByOwnerAsync(string ownerId, CancellationToken cancellationToken);

    /// <summary>Updates name and/or tags (null = unchanged) and returns the new document, or null when unknown.</summary>
    Task<ServerDocument?> UpdateNameTagsAsync(string serverId, string? name, IReadOnlyList<string>? tags, CancellationToken cancellationToken);

    Task<bool> DeleteAsync(string serverId, CancellationToken cancellationToken);

    /// <summary>Moves tokenHash to previousTokenHash (valid until the given time) and stores the new hash.</summary>
    Task<bool> RotateTokenAsync(string serverId, string newTokenHash, DateTime previousTokenValidUntil, CancellationToken cancellationToken);

    /// <summary>Sets silencedUntil (null clears it). False when the server is unknown.</summary>
    Task<bool> SilenceAsync(string serverId, DateTime? until, CancellationToken cancellationToken);

    /// <summary>Replaces the rule overrides (null = unchanged, empty = use account defaults) and/or the mute flag; returns the new document.</summary>
    Task<ServerDocument?> UpdateAlertSettingsAsync(string serverId, Dictionary<string, RuleSettingDocument>? overrides, bool? muted, bool clearSilence, CancellationToken cancellationToken);
}

internal sealed class MongoServerStore(MongoContext mongo, ILogger<MongoServerStore> logger) : IServerStore
{
    private IMongoCollection<ServerDocument> Servers => mongo.Db.GetCollection<ServerDocument>(ServerDocument.Collection);

    public async Task<ServerDocument?> FindByTokenHashAsync(string tokenHash, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return null;
        }

        try
        {
            return await Servers.Find(s => s.TokenHash == tokenHash).FirstOrDefaultAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("could not look up server by token: {Error}", ex.Message);
            return null;
        }
    }

    public async Task UpsertAsync(ServerDocument doc, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return;
        }

        try
        {
            var update = Builders<ServerDocument>.Update
                .Set(s => s.Hostname, doc.Hostname)
                .Set(s => s.Name, doc.Name)
                .Set(s => s.TokenHash, doc.TokenHash)
                .Set(s => s.Status, doc.Status)
                .Set(s => s.LastSeenAt, doc.LastSeenAt)
                .Set(s => s.AgentVersion, doc.AgentVersion)
                .Set(s => s.Os, doc.Os)
                .Set(s => s.Kernel, doc.Kernel)
                .Set(s => s.Arch, doc.Arch)
                .Set(s => s.Cores, doc.Cores)
                .Set(s => s.RamBytes, doc.RamBytes)
                .Set(s => s.DockerMode, doc.DockerMode)
                .Set(s => s.Kind, doc.Kind)
                .Set(s => s.ContainerId, doc.ContainerId)
                .Set(s => s.Capabilities, doc.Capabilities)
                .Set(s => s.Image, doc.Image)
                .SetOnInsert(s => s.OwnerId, doc.OwnerId)
                .SetOnInsert(s => s.Tags, doc.Tags)
                .SetOnInsert(s => s.CreatedAt, doc.CreatedAt == default ? DateTime.UtcNow : doc.CreatedAt);
            await Servers.UpdateOneAsync(s => s.Id == doc.Id, update, new UpdateOptions { IsUpsert = true }, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("could not save server {ServerId}: {Error}", doc.Id, ex.Message);
        }
    }

    public async Task InsertAsync(ServerDocument doc, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return;
        }

        await Servers.InsertOneAsync(doc, cancellationToken: cancellationToken);
    }

    public async Task TouchAsync(string serverId, DateTime? lastSeenAt, string status, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return;
        }

        try
        {
            var update = Builders<ServerDocument>.Update.Set(s => s.LastSeenAt, lastSeenAt).Set(s => s.Status, status);
            await Servers.UpdateOneAsync(s => s.Id == serverId, update, cancellationToken: cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("could not update lastSeenAt for {ServerId}: {Error}", serverId, ex.Message);
        }
    }

    public async Task<ServerDocument?> FindAsync(string serverId, CancellationToken cancellationToken) =>
        mongo.IsAvailable ? await Servers.Find(s => s.Id == serverId).FirstOrDefaultAsync(cancellationToken) : null;

    public async Task<IReadOnlyList<ServerDocument>> ListByIdsAsync(IEnumerable<string> serverIds, CancellationToken cancellationToken)
    {
        var ids = serverIds.Distinct().ToList();
        if (!mongo.IsAvailable || ids.Count == 0)
        {
            return [];
        }

        return await Servers.Find(Builders<ServerDocument>.Filter.In(s => s.Id, ids)).SortBy(s => s.Name).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<ServerDocument>> ListByOwnersAsync(IEnumerable<string> ownerIds, CancellationToken cancellationToken)
    {
        var ids = ownerIds.Distinct().ToList();
        if (!mongo.IsAvailable || ids.Count == 0)
        {
            return [];
        }

        return await Servers.Find(Builders<ServerDocument>.Filter.In(s => s.OwnerId, ids)).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<ServerDocument>> ListOwnerlessAsync(CancellationToken cancellationToken) =>
        mongo.IsAvailable ? await Servers.Find(s => s.OwnerId == null).ToListAsync(cancellationToken) : [];

    public async Task<long> CountByOwnerAsync(string ownerId, CancellationToken cancellationToken) =>
        mongo.IsAvailable ? await Servers.CountDocumentsAsync(s => s.OwnerId == ownerId, cancellationToken: cancellationToken) : 0;

    public async Task<ServerDocument?> UpdateNameTagsAsync(string serverId, string? name, IReadOnlyList<string>? tags, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return null;
        }

        var updates = new List<UpdateDefinition<ServerDocument>>();
        if (name is not null)
        {
            updates.Add(Builders<ServerDocument>.Update.Set(s => s.Name, name));
        }

        if (tags is not null)
        {
            updates.Add(Builders<ServerDocument>.Update.Set(s => s.Tags, tags.ToList()));
        }

        if (updates.Count == 0)
        {
            return await FindAsync(serverId, cancellationToken);
        }

        return await Servers.FindOneAndUpdateAsync(
            s => s.Id == serverId,
            Builders<ServerDocument>.Update.Combine(updates),
            new FindOneAndUpdateOptions<ServerDocument> { ReturnDocument = ReturnDocument.After },
            cancellationToken);
    }

    public async Task<bool> DeleteAsync(string serverId, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return false;
        }

        var result = await Servers.DeleteOneAsync(s => s.Id == serverId, cancellationToken);
        return result.DeletedCount > 0;
    }

    public async Task<bool> RotateTokenAsync(string serverId, string newTokenHash, DateTime previousTokenValidUntil, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return false;
        }

        // Pipeline update so the old hash is copied server-side in the same operation.
        var pipeline = PipelineDefinition<ServerDocument, ServerDocument>.Create(
        [
            new BsonDocument("$set", new BsonDocument
            {
                ["previousTokenHash"] = "$tokenHash",
                ["previousTokenValidUntil"] = previousTokenValidUntil,
                ["tokenHash"] = newTokenHash,
            }),
        ]);
        var result = await Servers.UpdateOneAsync(s => s.Id == serverId, Builders<ServerDocument>.Update.Pipeline(pipeline), cancellationToken: cancellationToken);
        return result.MatchedCount > 0;
    }

    public async Task<bool> SilenceAsync(string serverId, DateTime? until, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return false;
        }

        var result = await Servers.UpdateOneAsync(s => s.Id == serverId, Builders<ServerDocument>.Update.Set(s => s.SilencedUntil, until), cancellationToken: cancellationToken);
        return result.MatchedCount > 0;
    }

    public async Task<ServerDocument?> UpdateAlertSettingsAsync(string serverId, Dictionary<string, RuleSettingDocument>? overrides, bool? muted, bool clearSilence, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return null;
        }

        var updates = new List<UpdateDefinition<ServerDocument>>();
        if (overrides is not null)
        {
            updates.Add(Builders<ServerDocument>.Update.Set(s => s.AlertOverrides, overrides.Count == 0 ? null : overrides));
        }

        if (muted is { } m)
        {
            updates.Add(Builders<ServerDocument>.Update.Set(s => s.AlertsMuted, m));
        }

        if (clearSilence)
        {
            updates.Add(Builders<ServerDocument>.Update.Set(s => s.SilencedUntil, null));
        }

        if (updates.Count == 0)
        {
            return await FindAsync(serverId, cancellationToken);
        }

        return await Servers.FindOneAndUpdateAsync(
            s => s.Id == serverId,
            Builders<ServerDocument>.Update.Combine(updates),
            new FindOneAndUpdateOptions<ServerDocument> { ReturnDocument = ReturnDocument.After },
            cancellationToken);
    }
}
