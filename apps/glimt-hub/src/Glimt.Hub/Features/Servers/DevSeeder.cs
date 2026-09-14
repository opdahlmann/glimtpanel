using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Servers;

/// <summary>
/// In development and e2e: makes sure the developer account from GLIMT_DEV_USER_EMAIL /
/// GLIMT_DEV_USER_PASSWORD exists in `users`. Idempotent, logs once, skips when MongoDB is unavailable.
/// </summary>
internal sealed class DevSeeder(GlimtOptions options, MongoContext mongo, MongoIndexes indexes, TimeProvider clock, ILogger<DevSeeder> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.IsDevelopmentLike)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(options.DevUserEmail) || string.IsNullOrEmpty(options.DevUserPassword))
        {
            logger.LogWarning("dev user not seeded: GLIMT_DEV_USER_EMAIL or GLIMT_DEV_USER_PASSWORD is empty");
            return;
        }

        try
        {
            if (!await mongo.Ready.WaitAsync(stoppingToken))
            {
                logger.LogWarning("dev user {Email} not seeded: MongoDB {Database} unavailable", options.DevUserEmail, mongo.DatabaseName);
                return;
            }

            await indexes.Done.WaitAsync(stoppingToken);
            await SeedAsync(options.DevUserEmail.Trim().ToLowerInvariant(), options.DevUserPassword, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
        catch (Exception ex)
        {
            logger.LogWarning("dev user {Email} not seeded: {Error}", options.DevUserEmail, ex.Message);
        }
    }

    /// <summary>The container node `npm run dev -- --sidecar` connects as (GLIMT_DEV_CONTAINER_TOKEN), step 12.4.</summary>
    public const string DevNodeId = "dev-sidecar";
    public const string DevNodeName = "sidecar-dev";

    private async Task SeedAsync(string email, string password, CancellationToken cancellationToken)
    {
        var users = mongo.Db.GetCollection<UserDocument>(UserDocument.Collection);
        var existing = await users.Find(u => u.Email == email).FirstOrDefaultAsync(cancellationToken);
        if (existing is not null)
        {
            logger.LogInformation("dev user {Email} already exists in {Database}", email, mongo.DatabaseName);
            await SeedNodeAsync(existing.Id, cancellationToken);
            return;
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var user = new UserDocument
        {
            Email = email,
            Name = "Developer",
            PasswordHash = PasswordHasher.Hash(password),
            EmailConfirmedAt = now,
            Plan = "beta",
            Slots = new SlotsDocument { Free = 2, Paid = 0 },
            Timezone = "Europe/Oslo",
            Language = "en",
            CreatedAt = now,
        };

        try
        {
            await users.InsertOneAsync(user, cancellationToken: cancellationToken);
            logger.LogInformation("seeded dev user {Email} in {Database}", email, mongo.DatabaseName);
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            logger.LogInformation("dev user {Email} already exists in {Database}", email, mongo.DatabaseName);
        }

        await SeedNodeAsync(user.Id, cancellationToken);
    }

    /// <summary>A container node on the dev account whose token is GLIMT_DEV_CONTAINER_TOKEN; the hash is refreshed when the token changes.</summary>
    private async Task SeedNodeAsync(string ownerId, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.DevContainerToken))
        {
            return;
        }

        var servers = mongo.Db.GetCollection<ServerDocument>(ServerDocument.Collection);
        var hash = AgentTokens.Hash(options.DevContainerToken.Trim());
        var now = clock.GetUtcNow().UtcDateTime;
        var update = Builders<ServerDocument>.Update
            .Set(s => s.TokenHash, hash)
            .Set(s => s.Kind, NodeKinds.Container)
            .SetOnInsert(s => s.OwnerId, ownerId)
            .SetOnInsert(s => s.Name, DevNodeName)
            .SetOnInsert(s => s.Hostname, DevNodeName)
            .SetOnInsert(s => s.Tags, new List<string> { "dev" })
            .SetOnInsert(s => s.Status, ServerStatuses.Down)
            .SetOnInsert(s => s.CreatedAt, now);
        await servers.UpdateOneAsync(s => s.Id == DevNodeId, update, new UpdateOptions { IsUpsert = true }, cancellationToken);
        logger.LogInformation("dev container node {Name} ({Id}) ready for GLIMT_DEV_CONTAINER_TOKEN", DevNodeName, DevNodeId);
    }
}
