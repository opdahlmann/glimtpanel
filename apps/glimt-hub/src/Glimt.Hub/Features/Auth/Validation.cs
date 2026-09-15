using System.Text.RegularExpressions;

namespace Glimt.Hub.Features.Auth;

/// <summary>Input rules shared by Auth, Account and Access, plus the ProblemDetails helpers the endpoints use.</summary>
public static partial class Validation
{
    public const int NameMaxLength = 80;
    public const int EmailMaxLength = 254;

    [GeneratedRegex(@"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")]
    private static partial Regex EmailPattern();

    /// <summary>Trimmed, lowercase e-mail, or null when the value is not a plausible address.</summary>
    public static string? NormalizeEmail(string? email)
    {
        if (string.IsNullOrWhiteSpace(email))
        {
            return null;
        }

        var normalized = email.Trim().ToLowerInvariant();
        return normalized.Length <= EmailMaxLength && EmailPattern().IsMatch(normalized) ? normalized : null;
    }

    /// <summary>Name of 1–max characters with runs of whitespace collapsed, or null when invalid. Users 80, servers 64, groups 40.</summary>
    public static string? NormalizeName(string? name, int max = NameMaxLength)
    {
        var trimmed = string.Join(' ', (name ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        return trimmed.Length is 0 || trimmed.Length > max ? null : trimmed;
    }

    public static bool IsLanguage(string? language) => language is "en" or "no";

    public static bool IsTimezone(string? timezone) =>
        !string.IsNullOrWhiteSpace(timezone)
        && timezone.Length <= 64
        && TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out _);

    /// <summary>Two-letter initials from a name ("Ola Nordmann" → "ON") or an e-mail local part ("ola.nordmann@…" → "ON").</summary>
    public static string Initials(string? name, string email)
    {
        var parts = string.IsNullOrWhiteSpace(name)
            ? email.Split('@')[0].Split(['.', '_', '-', '+'], StringSplitOptions.RemoveEmptyEntries)
            : name.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var initials = string.Concat(parts.Take(2).Select(p => char.ToUpperInvariant(p[0])));
        if (initials.Length == 1 && parts[0].Length > 1)
        {
            initials += char.ToUpperInvariant(parts[0][1]);
        }

        return initials.Length == 0 ? "?" : initials;
    }

    public static IResult ValidationProblem(string field, string message) =>
        Results.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });

    public static IResult ValidationProblem(Dictionary<string, string[]> errors) => Results.ValidationProblem(errors);

    public static IResult Problem(int status, string title, string? detail = null, string? code = null) =>
        Results.Problem(
            statusCode: status,
            title: title,
            detail: detail,
            extensions: code is null ? null : new Dictionary<string, object?> { ["code"] = code });

    public static IResult Unauthorized(string title = "Unauthorized", string? code = null) => Problem(StatusCodes.Status401Unauthorized, title, code: code);

    public static IResult Forbidden(string title = "Forbidden", string? code = null) => Problem(StatusCodes.Status403Forbidden, title, code: code);

    public static IResult NotFound(string title = "Not found") => Problem(StatusCodes.Status404NotFound, title);
}
