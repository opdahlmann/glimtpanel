using MongoDB.Bson.Serialization.Attributes;

namespace Glimt.Hub.Features.Groups;

/// <summary>
/// Collection `groups` (IMPLEMENTERINGSPLAN 4.4, step 13.1): a personal, named set of nodes across servers,
/// containers, projects and clouds. Membership is explicit (ids), not tag based; a node may be in several groups.
/// </summary>
public sealed class GroupDocument
{
    public const string Collection = "groups";
    public const int NameMaxLength = 40;
    public const int MaxPerUser = 50;
    public const int MaxMembers = 100;

    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..16];

    public string OwnerId { get; set; } = "";

    public string Name { get; set; } = "";

    /// <summary>Server ids (both kinds). Ids the owner no longer sees are hidden when read, never removed here.</summary>
    public List<string> MemberIds { get; set; } = [];

    /// <summary>Position in the owner's list; PATCH moves groups by rewriting this.</summary>
    public int Order { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }
}
