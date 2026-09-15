using System.Security.Cryptography;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Infrastructure;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Servers;

/// <summary>Collection `enrolKeys` (IMPLEMENTERINGSPLAN 4.4). TTL on expiresAt; usedAt set when the agent consumes the key.</summary>
public sealed class EnrolKeyDocument
{
    public const string Collection = "enrolKeys";

    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString();

    public string KeyHash { get; set; } = "";
    public string OwnerId { get; set; } = "";
    public string DockerMode { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime? UsedAt { get; set; }
    public DateTime CreatedAt { get; set; }
}

public static class DockerModes
{
    public const string Proxy = "proxy";
    public const string Simple = "simple";
    public const string None = "none";

    public static bool IsValid(string? mode) => mode is Proxy or Simple or None;
}

/// <summary>One-time keys `gp_` + 22 base62 characters, valid 1 hour, consumed atomically by the agent's hello.</summary>
public sealed class MongoEnrolKeyStore(MongoContext mongo, TimeProvider clock, ILogger<MongoEnrolKeyStore> logger) : IEnrolKeyStore
{
    public const string Prefix = "gp_";
    public const int KeyLength = 22;
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(1);

    private const string Base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    private IMongoCollection<EnrolKeyDocument> Keys => mongo.Db.GetCollection<EnrolKeyDocument>(EnrolKeyDocument.Collection);

    public static string GenerateKey() => Prefix + RandomNumberGenerator.GetString(Base62, KeyLength);

    /// <summary>Creates a key for the owner and returns the plain key (only its hash is stored) with its expiry.</summary>
    public async Task<(string Key, DateTime ExpiresAt)> CreateAsync(string ownerId, string dockerMode, CancellationToken cancellationToken)
    {
        var key = GenerateKey();
        var now = clock.GetUtcNow().UtcDateTime;
        var doc = new EnrolKeyDocument
        {
            KeyHash = Auth.Tokens.Hash(key),
            OwnerId = ownerId,
            DockerMode = dockerMode,
            ExpiresAt = now.Add(Lifetime),
            CreatedAt = now,
        };
        await Keys.InsertOneAsync(doc, cancellationToken: cancellationToken);
        return (key, doc.ExpiresAt);
    }

    public async Task<EnrolKeyInfo?> TryConsumeAsync(string key, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable || string.IsNullOrWhiteSpace(key))
        {
            return null;
        }

        try
        {
            var now = clock.GetUtcNow().UtcDateTime;
            var hash = Auth.Tokens.Hash(key.Trim());
            var doc = await Keys.FindOneAndUpdateAsync(
                k => k.KeyHash == hash && k.UsedAt == null && k.ExpiresAt > now,
                Builders<EnrolKeyDocument>.Update.Set(k => k.UsedAt, now),
                cancellationToken: cancellationToken);
            return doc is null ? null : new EnrolKeyInfo(doc.OwnerId, doc.DockerMode);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("could not consume enrol key: {Error}", ex.Message);
            return null;
        }
    }

    public Task DeleteAllForOwnerAsync(string ownerId, CancellationToken cancellationToken) =>
        Keys.DeleteManyAsync(k => k.OwnerId == ownerId, cancellationToken);
}
