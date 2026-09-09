using MongoDB.Bson.Serialization.Attributes;

namespace Glimt.Hub.Features.Access;

public static class GrantScopes
{
    public const string All = "all";
    public const string Tags = "tags";
}

public static class GrantStatuses
{
    public const string Pending = "pending";
    public const string Accepted = "accepted";
}

/// <summary>
/// Collection `accessGrants` (IMPLEMENTERINGSPLAN 4.4): read access an owner gives to an e-mail address.
/// Scope is stored as <c>scope: "all"</c> or <c>scope: "tags"</c> plus <c>tags[]</c> (one queryable shape instead of a mixed-type field).
/// </summary>
public sealed class AccessGrantDocument
{
    public const string Collection = "accessGrants";
    public const string RoleReader = "reader";

    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString();

    public string OwnerId { get; set; } = "";

    /// <summary>Lowercase.</summary>
    public string Email { get; set; } = "";

    /// <summary>Set when the invited e-mail has an account (immediately, at register, or at accept).</summary>
    public string? UserId { get; set; }

    public string Role { get; set; } = RoleReader;
    public string Scope { get; set; } = GrantScopes.All;
    public List<string> Tags { get; set; } = [];
    public string Status { get; set; } = GrantStatuses.Pending;
    public string? InviteTokenHash { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? AcceptedAt { get; set; }

    /// <summary>True when the grant covers a server with the given tags.</summary>
    public bool Covers(IEnumerable<string> serverTags) =>
        Scope == GrantScopes.All || serverTags.Any(t => Tags.Contains(t, StringComparer.Ordinal));
}
