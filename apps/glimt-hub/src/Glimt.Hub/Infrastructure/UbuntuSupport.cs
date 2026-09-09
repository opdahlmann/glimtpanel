namespace Glimt.Hub.Infrastructure;

/// <summary>
/// End of standard support for Ubuntu LTS releases (IMPLEMENTERINGSPLAN step 2.9). Other distributions and
/// unknown versions give null (the web app shows "unknown").
/// </summary>
public static class UbuntuSupport
{
    private static readonly IReadOnlyDictionary<string, DateOnly> Table = new Dictionary<string, DateOnly>(StringComparer.Ordinal)
    {
        ["20.04"] = new(2025, 5, 31),
        ["22.04"] = new(2027, 4, 30),
        ["24.04"] = new(2029, 4, 30),
        ["26.04"] = new(2031, 4, 30),
    };

    /// <summary>The last day of standard support, or null when the OS is not Ubuntu or the version is unknown.</summary>
    public static DateOnly? SupportUntil(string? osId, string? versionId)
    {
        if (!string.Equals(osId, "ubuntu", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(versionId))
        {
            return null;
        }

        return Table.TryGetValue(versionId.Trim(), out var date) ? date : null;
    }

    /// <summary>True when today is after the support date. Unknown versions are never reported as EOL.</summary>
    public static bool IsEol(DateOnly? supportUntil, DateOnly today) => supportUntil is { } until && today > until;
}
