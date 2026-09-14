using MongoDB.Bson.Serialization.Attributes;

namespace Glimt.Hub.Features.Auth;

/// <summary>Collection `refreshTokens` (IMPLEMENTERINGSPLAN 4.4). Only the SHA-256 hash of the token is stored.</summary>
public sealed class RefreshTokenDocument
{
    public const string Collection = "refreshTokens";

    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString();

    public string UserId { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }

    /// <summary>Why it was revoked: rotated, logout, logoutAll, passwordReset, passwordChange, reuse.</summary>
    public string? RevokedReason { get; set; }

    /// <summary>User-Agent of the browser that logged in, trimmed.</summary>
    public string? Device { get; set; }

    public DateTime CreatedAt { get; set; }
}

/// <summary>Collection `emailTokens`: confirm (24 h) and reset (1 h) links. Deleted when used; TTL on expiresAt.</summary>
public sealed class EmailTokenDocument
{
    public const string Collection = "emailTokens";
    public const string PurposeConfirm = "confirm";
    public const string PurposeReset = "reset";

    /// <summary>Changing the account's e-mail (step 8.2): the token carries the new address in <see cref="Payload"/>.</summary>
    public const string PurposeEmailChange = "email-change";

    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString();

    public string UserId { get; set; } = "";
    public string Purpose { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; }

    /// <summary>Purpose-specific data (the new e-mail for email-change).</summary>
    public string? Payload { get; set; }
}

/// <summary>Collection `counters`: atomic sequences, e.g. _id "users" for the early-adopter limit.</summary>
public sealed class CounterDocument
{
    public const string Collection = "counters";
    public const string Users = "users";

    [BsonId]
    public string Id { get; set; } = "";

    public long Seq { get; set; }
}
