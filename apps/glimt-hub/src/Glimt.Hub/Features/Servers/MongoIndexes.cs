using Glimt.Hub.Features.Access;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Servers;

/// <summary>Creates the indexes from IMPLEMENTERINGSPLAN 4.4 once MongoDB answers. Idempotent.</summary>
internal sealed class MongoIndexes(MongoContext mongo, ILogger<MongoIndexes> logger) : BackgroundService
{
    private static readonly TimeSpan Ttl = TimeSpan.Zero;

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

            await CreateAsync(stoppingToken);
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

    private async Task CreateAsync(CancellationToken cancellationToken)
    {
        var users = mongo.Db.GetCollection<UserDocument>(UserDocument.Collection);
        await users.Indexes.CreateOneAsync(
            new CreateIndexModel<UserDocument>(
                Builders<UserDocument>.IndexKeys.Ascending(u => u.Email),
                new CreateIndexOptions { Unique = true, Name = "email_unique" }),
            cancellationToken: cancellationToken);

        var servers = mongo.Db.GetCollection<ServerDocument>(ServerDocument.Collection);
        await servers.Indexes.CreateManyAsync(
            [
                new CreateIndexModel<ServerDocument>(Builders<ServerDocument>.IndexKeys.Ascending(s => s.OwnerId), new CreateIndexOptions { Name = "ownerId" }),
                new CreateIndexModel<ServerDocument>(Builders<ServerDocument>.IndexKeys.Ascending(s => s.TokenHash), new CreateIndexOptions { Name = "tokenHash" }),
            ],
            cancellationToken);

        var refreshTokens = mongo.Db.GetCollection<RefreshTokenDocument>(RefreshTokenDocument.Collection);
        await refreshTokens.Indexes.CreateManyAsync(
            [
                new CreateIndexModel<RefreshTokenDocument>(Builders<RefreshTokenDocument>.IndexKeys.Ascending(t => t.TokenHash), new CreateIndexOptions { Name = "tokenHash" }),
                new CreateIndexModel<RefreshTokenDocument>(Builders<RefreshTokenDocument>.IndexKeys.Ascending(t => t.UserId), new CreateIndexOptions { Name = "userId" }),
                new CreateIndexModel<RefreshTokenDocument>(Builders<RefreshTokenDocument>.IndexKeys.Ascending(t => t.ExpiresAt), new CreateIndexOptions { Name = "expiresAt_ttl", ExpireAfter = Ttl }),
            ],
            cancellationToken);

        var emailTokens = mongo.Db.GetCollection<EmailTokenDocument>(EmailTokenDocument.Collection);
        await emailTokens.Indexes.CreateManyAsync(
            [
                new CreateIndexModel<EmailTokenDocument>(Builders<EmailTokenDocument>.IndexKeys.Ascending(t => t.TokenHash), new CreateIndexOptions { Name = "tokenHash" }),
                new CreateIndexModel<EmailTokenDocument>(Builders<EmailTokenDocument>.IndexKeys.Ascending(t => t.ExpiresAt), new CreateIndexOptions { Name = "expiresAt_ttl", ExpireAfter = Ttl }),
            ],
            cancellationToken);

        var enrolKeys = mongo.Db.GetCollection<EnrolKeyDocument>(EnrolKeyDocument.Collection);
        await enrolKeys.Indexes.CreateManyAsync(
            [
                new CreateIndexModel<EnrolKeyDocument>(Builders<EnrolKeyDocument>.IndexKeys.Ascending(k => k.KeyHash), new CreateIndexOptions { Name = "keyHash" }),
                new CreateIndexModel<EnrolKeyDocument>(Builders<EnrolKeyDocument>.IndexKeys.Ascending(k => k.ExpiresAt), new CreateIndexOptions { Name = "expiresAt_ttl", ExpireAfter = Ttl }),
            ],
            cancellationToken);

        var grants = mongo.Db.GetCollection<AccessGrantDocument>(AccessGrantDocument.Collection);
        await grants.Indexes.CreateManyAsync(
            [
                new CreateIndexModel<AccessGrantDocument>(Builders<AccessGrantDocument>.IndexKeys.Ascending(g => g.OwnerId), new CreateIndexOptions { Name = "ownerId" }),
                new CreateIndexModel<AccessGrantDocument>(Builders<AccessGrantDocument>.IndexKeys.Ascending(g => g.UserId), new CreateIndexOptions { Name = "userId" }),
                new CreateIndexModel<AccessGrantDocument>(
                    Builders<AccessGrantDocument>.IndexKeys.Ascending(g => g.OwnerId).Ascending(g => g.Email),
                    new CreateIndexOptions { Name = "ownerId_email_unique", Unique = true }),
            ],
            cancellationToken);

        var alerts = mongo.Db.GetCollection<AlertDocument>(AlertDocument.Collection);
        await alerts.Indexes.CreateManyAsync(
            [
                new CreateIndexModel<AlertDocument>(Builders<AlertDocument>.IndexKeys.Ascending(a => a.OwnerId).Descending(a => a.FiredAt), new CreateIndexOptions { Name = "ownerId_firedAt" }),
                new CreateIndexModel<AlertDocument>(Builders<AlertDocument>.IndexKeys.Ascending(a => a.ServerId).Ascending(a => a.State), new CreateIndexOptions { Name = "serverId_state" }),
            ],
            cancellationToken);

        var alertSettings = mongo.Db.GetCollection<AlertSettingsDocument>(AlertSettingsDocument.Collection);
        await alertSettings.Indexes.CreateOneAsync(
            new CreateIndexModel<AlertSettingsDocument>(Builders<AlertSettingsDocument>.IndexKeys.Ascending(s => s.UserId), new CreateIndexOptions { Name = "userId_unique", Unique = true }),
            cancellationToken: cancellationToken);

        var push = mongo.Db.GetCollection<PushSubscriptionDocument>(PushSubscriptionDocument.Collection);
        await push.Indexes.CreateManyAsync(
            [
                new CreateIndexModel<PushSubscriptionDocument>(Builders<PushSubscriptionDocument>.IndexKeys.Ascending(p => p.UserId), new CreateIndexOptions { Name = "userId" }),
                new CreateIndexModel<PushSubscriptionDocument>(Builders<PushSubscriptionDocument>.IndexKeys.Ascending(p => p.Endpoint), new CreateIndexOptions { Name = "endpoint_unique", Unique = true }),
            ],
            cancellationToken);
    }
}
