using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Auth;

/// <summary>Single-use tokens for confirmation and password-reset links (`emailTokens`).</summary>
public sealed class EmailTokenStore(MongoContext mongo, TimeProvider clock)
{
    public static readonly TimeSpan ConfirmLifetime = TimeSpan.FromHours(24);
    public static readonly TimeSpan ResetLifetime = TimeSpan.FromHours(1);

    private IMongoCollection<EmailTokenDocument> Collection => mongo.Db.GetCollection<EmailTokenDocument>(EmailTokenDocument.Collection);

    /// <summary>Creates a token and returns the plain value for the link. Earlier tokens with the same purpose are removed.</summary>
    public async Task<string> CreateAsync(string userId, string purpose, CancellationToken cancellationToken, string? payload = null)
    {
        var lifetime = purpose == EmailTokenDocument.PurposeReset ? ResetLifetime : ConfirmLifetime;
        var token = Auth.Tokens.Generate();
        var now = clock.GetUtcNow().UtcDateTime;
        await Collection.DeleteManyAsync(t => t.UserId == userId && t.Purpose == purpose, cancellationToken);
        await Collection.InsertOneAsync(new EmailTokenDocument
        {
            UserId = userId,
            Purpose = purpose,
            TokenHash = Auth.Tokens.Hash(token),
            ExpiresAt = now.Add(lifetime),
            CreatedAt = now,
            Payload = payload,
        }, cancellationToken: cancellationToken);
        return token;
    }

    /// <summary>As <see cref="ConsumeAsync"/>, also returning the payload (the new e-mail for email-change).</summary>
    public async Task<(string UserId, string? Payload)?> ConsumeWithPayloadAsync(string token, string purpose, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var hash = Auth.Tokens.Hash(token.Trim());
        var doc = await Collection.FindOneAndDeleteAsync(t => t.TokenHash == hash && t.Purpose == purpose, cancellationToken: cancellationToken);
        return doc is null || doc.ExpiresAt <= now ? null : (doc.UserId, doc.Payload);
    }

    /// <summary>Deletes the token and returns its user id, or null when unknown, wrong purpose or expired.</summary>
    public async Task<string?> ConsumeAsync(string token, string purpose, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var hash = Auth.Tokens.Hash(token.Trim());
        var doc = await Collection.FindOneAndDeleteAsync(t => t.TokenHash == hash && t.Purpose == purpose, cancellationToken: cancellationToken);
        return doc is null || doc.ExpiresAt <= now ? null : doc.UserId;
    }

    public Task DeleteAllAsync(string userId, CancellationToken cancellationToken) =>
        Collection.DeleteManyAsync(t => t.UserId == userId, cancellationToken);
}
