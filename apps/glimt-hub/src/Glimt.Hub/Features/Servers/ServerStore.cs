using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Servers;

/// <summary>Persistence for the `servers` collection. Every call is a no-op when MongoDB is unavailable.</summary>
public interface IServerStore
{
    Task<ServerDocument?> FindByTokenHashAsync(string tokenHash, CancellationToken cancellationToken);

    /// <summary>Inserts or updates the server; createdAt and ownerId are only set on insert.</summary>
    Task UpsertAsync(ServerDocument doc, CancellationToken cancellationToken);

    Task TouchAsync(string serverId, DateTime? lastSeenAt, string status, CancellationToken cancellationToken);
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
}
