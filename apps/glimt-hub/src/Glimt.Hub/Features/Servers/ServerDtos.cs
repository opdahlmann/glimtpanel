using System.Text.RegularExpressions;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Servers;

public static class ServerRoles
{
    public const string Owner = "owner";
    public const string Reader = "reader";
}

public sealed record OsDto(string Id, string VersionId, string PrettyName);

/// <summary>GET /api/servers and GET /api/servers/{id} (IMPLEMENTERINGSPLAN 4.3, steps 2.4 and 2.9).</summary>
public sealed record ServerDto(
    string Id,
    string Name,
    string Hostname,
    IReadOnlyList<string> Tags,
    string Status,
    DateTimeOffset? LastSeenAt,
    string Role,
    string? OwnerEmail,
    OsDto? Os,
    string? Kernel,
    string? Arch,
    int Cores,
    long RamBytes,
    string? DockerMode,
    DateTimeOffset CreatedAt,
    DateOnly? SupportUntil,
    bool Eol)
{
    /// <summary>Builds the projection; status and last seen come from the live session when the registry knows the server.</summary>
    public static ServerDto From(ServerDocument doc, string role, string? ownerEmail, AgentSession? live, DateOnly today)
    {
        var supportUntil = UbuntuSupport.SupportUntil(doc.Os?.Id, doc.Os?.VersionId);
        DateTimeOffset? lastSeen = live?.LastSeenAt;
        if (lastSeen is null && doc.LastSeenAt is { } seen)
        {
            lastSeen = new DateTimeOffset(DateTime.SpecifyKind(seen, DateTimeKind.Utc));
        }

        return new ServerDto(
            doc.Id,
            doc.Name,
            doc.Hostname,
            doc.Tags,
            live?.Status ?? doc.Status,
            lastSeen,
            role,
            ownerEmail,
            doc.Os is { } os ? new OsDto(os.Id, os.VersionId, os.PrettyName) : null,
            doc.Kernel,
            doc.Arch,
            doc.Cores,
            doc.RamBytes,
            doc.DockerMode,
            new DateTimeOffset(DateTime.SpecifyKind(doc.CreatedAt, DateTimeKind.Utc)),
            supportUntil,
            UbuntuSupport.IsEol(supportUntil, today));
    }
}

public sealed record EnrolKeyRequest(string? DockerMode);

public sealed record EnrolKeyResponse(string Key, string Command, DateTimeOffset ExpiresAt, string DockerMode);

public sealed record PatchServerRequest(string? Name, List<string>? Tags);

public sealed record DeleteServerResponse(string UninstallCommand);

/// <summary>Tag rules shared by servers and access scopes: ≤ 10 tags of ^[a-z0-9-]{1,24}$, lowercased and deduplicated.</summary>
public static partial class ServerTags
{
    public const int MaxTags = 10;
    public const int NameMaxLength = 64;

    [GeneratedRegex("^[a-z0-9-]{1,24}$")]
    private static partial Regex TagPattern();

    /// <summary>Normalises the list, or returns null with an error message when a tag is invalid or there are too many.</summary>
    public static IReadOnlyList<string>? Normalize(IEnumerable<string?> tags, out string? error)
    {
        var result = new List<string>();
        foreach (var raw in tags)
        {
            var tag = raw?.Trim().ToLowerInvariant() ?? "";
            if (!TagPattern().IsMatch(tag))
            {
                error = $"Tag '{raw}' is invalid: use 1–24 characters of a-z, 0-9 and '-'.";
                return null;
            }

            if (!result.Contains(tag))
            {
                result.Add(tag);
            }
        }

        if (result.Count > MaxTags)
        {
            error = $"At most {MaxTags} tags.";
            return null;
        }

        error = null;
        return result;
    }

    public static string? NormalizeName(string? name)
    {
        var trimmed = name?.Trim();
        return string.IsNullOrEmpty(trimmed) || trimmed.Length > NameMaxLength ? null : trimmed;
    }
}
