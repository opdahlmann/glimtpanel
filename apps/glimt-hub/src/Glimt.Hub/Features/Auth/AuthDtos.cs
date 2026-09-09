using Glimt.Hub.Features.Servers;

namespace Glimt.Hub.Features.Auth;

/// <summary>The user as the web app sees it (login, confirm, refresh).</summary>
public sealed record UserDto(string Id, string Email, string Name, string Timezone, string Language, string Plan, bool EarlyAdopter, bool EmailConfirmed)
{
    public static UserDto From(UserDocument user) =>
        new(user.Id, user.Email, user.Name, user.Timezone, user.Language, user.Plan, user.EarlyAdopter, user.EmailConfirmedAt is not null);
}

/// <summary>GET /api/auth/me and GET /api/account: the user plus role information.</summary>
public sealed record MeDto(
    string Id,
    string Email,
    string Name,
    string Timezone,
    string Language,
    string Plan,
    bool EarlyAdopter,
    bool EmailConfirmed,
    bool OwnsServers,
    int ReaderOf)
{
    public static MeDto From(UserDocument user, bool ownsServers, int readerOf) =>
        new(user.Id, user.Email, user.Name, user.Timezone, user.Language, user.Plan, user.EarlyAdopter, user.EmailConfirmedAt is not null, ownsServers, readerOf);
}

public sealed record LoginResponse(string AccessToken, DateTimeOffset ExpiresAt, UserDto User);

public sealed record RegisterRequest(string? Email, string? Password, string? Name);

public sealed record TokenRequest(string? Token);

public sealed record EmailRequest(string? Email);

public sealed record LoginRequest(string? Email, string? Password);

public sealed record ResetPasswordRequest(string? Token, string? Password);

public sealed record ChangePasswordRequest(string? CurrentPassword, string? NewPassword);
