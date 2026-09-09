using MongoDB.Bson.Serialization.Attributes;

namespace Glimt.Hub.Features.Servers;

/// <summary>Collection `users` (IMPLEMENTERINGSPLAN 4.4). Written by Auth (register), read by Account and Access.</summary>
public sealed class UserDocument
{
    public const string Collection = "users";

    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString();

    /// <summary>Lowercase, unique.</summary>
    public string Email { get; set; } = "";

    public string Name { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public DateTime? EmailConfirmedAt { get; set; }
    public string Plan { get; set; } = "beta";
    public SlotsDocument Slots { get; set; } = new();
    /// <summary>True for the first 100 accounts (counter "users" in the counters collection).</summary>
    public bool EarlyAdopter { get; set; }

    public string Timezone { get; set; } = "Europe/Oslo";
    public string Language { get; set; } = "en";
    public DateTime CreatedAt { get; set; }
}

public sealed class SlotsDocument
{
    public int Free { get; set; } = 2;
    public int Paid { get; set; }
}
