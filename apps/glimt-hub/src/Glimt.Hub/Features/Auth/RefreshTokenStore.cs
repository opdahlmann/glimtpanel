using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Auth;

public static class RevokedReasons
{
    public const string Rotated = "rotated";
    public const string Logout = "logout";
    public const string LogoutAll = "logoutAll";
    public const string PasswordReset = "passwordReset";
    public const string PasswordChange = "passwordChange";
    public const string Reuse = "reuse";
    public const string AccountDeleted = "accountDeleted";
}

/// <summary>Rotating refresh tokens (30 days) in `refreshTokens`. Only hashes are stored; the token itself goes in the cookie.</summary>
public sealed class RefreshTokenStore(MongoContext mongo, TimeProvider clock)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(30);

    private IMongoCollection<RefreshTokenDocument> Collection => mongo.Db.GetCollection<RefreshTokenDocument>(RefreshTokenDocument.Collection);

    /// <summary>Creates a token for the user and returns the plain token (never stored) and its expiry.</summary>
    public async Task<(string Token, DateTime ExpiresAt)> CreateAsync(string userId, string? device, CancellationToken cancellationToken)
    {
        var token = Auth.Tokens.Generate();
        var now = clock.GetUtcNow().UtcDateTime;
        var doc = new RefreshTokenDocument
        {
            UserId = userId,
            TokenHash = Auth.Tokens.Hash(token),
            ExpiresAt = now.Add(Lifetime),
            Device = Trim(device),
            CreatedAt = now,
        };
        await Collection.InsertOneAsync(doc, cancellationToken: cancellationToken);
        return (token, doc.ExpiresAt);
    }

    /// <summary>The document for a token, revoked or not, or null when unknown.</summary>
    public Task<RefreshTokenDocument?> FindAsync(string token, CancellationToken cancellationToken) =>
        Collection.Find(t => t.TokenHash == Auth.Tokens.Hash(token)).FirstOrDefaultAsync(cancellationToken)!;

    /// <summary>Revokes one token; returns false when it was already revoked or unknown.</summary>
    public async Task<bool> RevokeAsync(string id, string reason, CancellationToken cancellationToken)
    {
        var result = await Collection.UpdateOneAsync(
            t => t.Id == id && t.RevokedAt == null,
            Builders<RefreshTokenDocument>.Update.Set(t => t.RevokedAt, clock.GetUtcNow().UtcDateTime).Set(t => t.RevokedReason, reason),
            cancellationToken: cancellationToken);
        return result.ModifiedCount > 0;
    }

    /// <summary>Revokes every active token of the user, optionally keeping one (the caller's own).</summary>
    public async Task<long> RevokeAllAsync(string userId, string reason, string? exceptId, CancellationToken cancellationToken)
    {
        var filter = Builders<RefreshTokenDocument>.Filter.Where(t => t.UserId == userId && t.RevokedAt == null);
        if (exceptId is not null)
        {
            filter &= Builders<RefreshTokenDocument>.Filter.Ne(t => t.Id, exceptId);
        }

        var result = await Collection.UpdateManyAsync(
            filter,
            Builders<RefreshTokenDocument>.Update.Set(t => t.RevokedAt, clock.GetUtcNow().UtcDateTime).Set(t => t.RevokedReason, reason),
            cancellationToken: cancellationToken);
        return result.ModifiedCount;
    }

    public Task DeleteAllAsync(string userId, CancellationToken cancellationToken) =>
        Collection.DeleteManyAsync(t => t.UserId == userId, cancellationToken);

    private static string? Trim(string? device)
    {
        if (string.IsNullOrWhiteSpace(device))
        {
            return null;
        }

        device = device.Trim();
        return device.Length <= 200 ? device : device[..200];
    }
}
