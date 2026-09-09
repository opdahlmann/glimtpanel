using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Servers;

/// <summary>Creates the indexes from IMPLEMENTERINGSPLAN 4.4 once MongoDB answers. Idempotent.</summary>
internal sealed class MongoIndexes(MongoContext mongo, ILogger<MongoIndexes> logger) : BackgroundService
{
    private readonly TaskCompletionSource _done = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Completes when index creation has finished or been skipped.</summary>
    public Task Done => _done.Task;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            if (!await mongo.Ready.WaitAsync(stoppingToken))
            {
                return;
            }

            var users = mongo.Db.GetCollection<UserDocument>(UserDocument.Collection);
            await users.Indexes.CreateOneAsync(
                new CreateIndexModel<UserDocument>(
                    Builders<UserDocument>.IndexKeys.Ascending(u => u.Email),
                    new CreateIndexOptions { Unique = true, Name = "email_unique" }),
                cancellationToken: stoppingToken);

            var servers = mongo.Db.GetCollection<ServerDocument>(ServerDocument.Collection);
            await servers.Indexes.CreateManyAsync(
                [
                    new CreateIndexModel<ServerDocument>(Builders<ServerDocument>.IndexKeys.Ascending(s => s.OwnerId), new CreateIndexOptions { Name = "ownerId" }),
                    new CreateIndexModel<ServerDocument>(Builders<ServerDocument>.IndexKeys.Ascending(s => s.TokenHash), new CreateIndexOptions { Name = "tokenHash" }),
                ],
                stoppingToken);

            logger.LogInformation("MongoDB indexes verified");
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
        catch (Exception ex)
        {
            logger.LogWarning("could not create MongoDB indexes: {Error}", ex.Message);
        }
        finally
        {
            _done.TrySetResult();
        }
    }
}
