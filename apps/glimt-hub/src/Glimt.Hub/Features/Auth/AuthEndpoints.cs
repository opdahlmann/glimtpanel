using System.Security.Claims;
using Glimt.Hub.Features.Access;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Auth;
using Glimt.Hub.Infrastructure.Email;

namespace Glimt.Hub.Features.Auth;

/// <summary>/api/auth (IMPLEMENTERINGSPLAN 4.3, step 2.2).</summary>
public static class AuthEndpoints
{
    public const string EmailNotConfirmed = "emailNotConfirmed";

    /// <summary>Hash verified when the e-mail is unknown, so a wrong e-mail takes as long as a wrong password.</summary>
    private static readonly Lazy<string> DummyHash = new(() => PasswordHasher.Hash("glimtpanel-timing-equalizer"));

    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/auth").AddEndpointFilter<RequireDatabase>();

        var open = group.MapGroup("").RequireRateLimiting(RateLimiting.AuthPolicy);
        open.MapPost("/register", RegisterAsync);
        open.MapPost("/confirm", ConfirmAsync);
        open.MapPost("/resend-confirmation", ResendConfirmationAsync);
        open.MapPost("/login", LoginAsync);
        open.MapPost("/forgot", ForgotAsync);
        open.MapPost("/reset", ResetAsync);

        var cookie = group.MapGroup("").RequireRateLimiting(RateLimiting.ApiPolicy);
        cookie.MapPost("/refresh", RefreshAsync);
        cookie.MapPost("/logout", LogoutAsync);

        var bearer = group.MapGroup("").RequireAuthorization().RequireRateLimiting(RateLimiting.ApiPolicy);
        bearer.MapPost("/logout-all", LogoutAllAsync);
        bearer.MapPost("/password", ChangePasswordAsync);
        bearer.MapGet("/me", MeAsync);
        return app;
    }

    private static async Task<IResult> RegisterAsync(
        RegisterRequest request,
        UserStore users,
        EmailTokenStore emailTokens,
        AccessGrantStore grants,
        AuthSessions sessions,
        IEmailSender mail,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var errors = new Dictionary<string, string[]>();
        var email = Validation.NormalizeEmail(request.Email);
        if (email is null)
        {
            errors["email"] = ["Enter a valid e-mail address."];
        }

        if (Passwords.Validate(request.Password) is { } passwordError)
        {
            errors["password"] = [passwordError];
        }

        var name = Validation.NormalizeName(request.Name);
        if (name is null)
        {
            errors["name"] = [$"Name must be 1–{Validation.NameMaxLength} characters."];
        }

        if (errors.Count > 0)
        {
            return Validation.ValidationProblem(errors);
        }

        if (await users.FindByEmailAsync(email!, cancellationToken) is not null)
        {
            return Validation.Problem(StatusCodes.Status409Conflict, "E-mail already registered", code: "emailTaken");
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var number = await users.NextUserNumberAsync(cancellationToken);
        var user = new UserDocument
        {
            Email = email!,
            Name = name!,
            PasswordHash = PasswordHasher.Hash(request.Password!),
            EmailConfirmedAt = null,
            Plan = "beta",
            Slots = new SlotsDocument { Free = 2, Paid = 0 },
            EarlyAdopter = number <= UserStore.EarlyAdopterLimit,
            CreatedAt = now,
        };
        if (!await users.TryInsertAsync(user, cancellationToken))
        {
            return Validation.Problem(StatusCodes.Status409Conflict, "E-mail already registered", code: "emailTaken");
        }

        await grants.LinkPendingAsync(user.Email, user.Id, now, cancellationToken);
        await SendConfirmationAsync(user, emailTokens, sessions, mail, cancellationToken);
        return Results.Created("/api/auth/me", UserDto.From(user));
    }

    private static async Task<IResult> ConfirmAsync(
        TokenRequest request,
        UserStore users,
        EmailTokenStore emailTokens,
        AuthSessions sessions,
        TimeProvider clock,
        HttpContext http,
        CancellationToken cancellationToken)
    {
        var userId = await emailTokens.ConsumeAsync(request.Token ?? "", EmailTokenDocument.PurposeConfirm, cancellationToken);
        if (userId is null)
        {
            return Validation.Problem(StatusCodes.Status400BadRequest, "Invalid or expired confirmation link", code: "invalidToken");
        }

        await users.ConfirmEmailAsync(userId, clock.GetUtcNow().UtcDateTime, cancellationToken);
        var user = await users.FindByIdAsync(userId, cancellationToken);
        if (user is null)
        {
            return Validation.Problem(StatusCodes.Status400BadRequest, "Invalid or expired confirmation link", code: "invalidToken");
        }

        return Results.Ok(await sessions.IssueAsync(http, user, cancellationToken));
    }

    private static async Task<IResult> ResendConfirmationAsync(
        EmailRequest request,
        UserStore users,
        EmailTokenStore emailTokens,
        AuthSessions sessions,
        IEmailSender mail,
        CancellationToken cancellationToken)
    {
        var email = Validation.NormalizeEmail(request.Email);
        if (email is not null && await users.FindByEmailAsync(email, cancellationToken) is { EmailConfirmedAt: null } user)
        {
            await SendConfirmationAsync(user, emailTokens, sessions, mail, cancellationToken);
        }

        return Results.NoContent();
    }

    private static async Task<IResult> LoginAsync(
        LoginRequest request,
        UserStore users,
        AuthSessions sessions,
        HttpContext http,
        CancellationToken cancellationToken)
    {
        var email = Validation.NormalizeEmail(request.Email);
        var user = email is null ? null : await users.FindByEmailAsync(email, cancellationToken);
        if (!PasswordHasher.Verify(request.Password ?? "", user?.PasswordHash ?? DummyHash.Value) || user is null)
        {
            return Validation.Unauthorized("Wrong e-mail or password", "invalidCredentials");
        }

        if (user.EmailConfirmedAt is null)
        {
            return Validation.Forbidden("E-mail not confirmed", EmailNotConfirmed);
        }

        return Results.Ok(await sessions.IssueAsync(http, user, cancellationToken));
    }

    private static async Task<IResult> RefreshAsync(
        UserStore users,
        RefreshTokenStore refreshTokens,
        AuthSessions sessions,
        TimeProvider clock,
        HttpContext http,
        CancellationToken cancellationToken)
    {
        var token = AuthSessions.ReadCookie(http);
        var stored = token is null ? null : await refreshTokens.FindAsync(token, cancellationToken);
        if (stored is null)
        {
            AuthSessions.ClearCookie(http);
            return Validation.Unauthorized("Refresh token missing or unknown", "refreshInvalid");
        }

        if (stored.RevokedAt is not null)
        {
            if (stored.RevokedReason == RevokedReasons.Rotated)
            {
                // A rotated token presented again: someone else holds the newer one. Revoke every session.
                await refreshTokens.RevokeAllAsync(stored.UserId, RevokedReasons.Reuse, null, cancellationToken);
            }

            AuthSessions.ClearCookie(http);
            return Validation.Unauthorized("Refresh token revoked", "refreshRevoked");
        }

        if (stored.ExpiresAt <= clock.GetUtcNow().UtcDateTime)
        {
            AuthSessions.ClearCookie(http);
            return Validation.Unauthorized("Refresh token expired", "refreshExpired");
        }

        var user = await users.FindByIdAsync(stored.UserId, cancellationToken);
        if (user is null)
        {
            AuthSessions.ClearCookie(http);
            return Validation.Unauthorized("Refresh token revoked", "refreshRevoked");
        }

        await refreshTokens.RevokeAsync(stored.Id, RevokedReasons.Rotated, cancellationToken);
        return Results.Ok(await sessions.IssueAsync(http, user, cancellationToken));
    }

    private static async Task<IResult> LogoutAsync(RefreshTokenStore refreshTokens, HttpContext http, CancellationToken cancellationToken)
    {
        if (AuthSessions.ReadCookie(http) is { } token && await refreshTokens.FindAsync(token, cancellationToken) is { } stored)
        {
            await refreshTokens.RevokeAsync(stored.Id, RevokedReasons.Logout, cancellationToken);
        }

        AuthSessions.ClearCookie(http);
        return Results.NoContent();
    }

    private static async Task<IResult> LogoutAllAsync(ClaimsPrincipal principal, RefreshTokenStore refreshTokens, HttpContext http, CancellationToken cancellationToken)
    {
        await refreshTokens.RevokeAllAsync(principal.RequireUserId(), RevokedReasons.LogoutAll, null, cancellationToken);
        AuthSessions.ClearCookie(http);
        return Results.NoContent();
    }

    private static async Task<IResult> ForgotAsync(
        EmailRequest request,
        UserStore users,
        EmailTokenStore emailTokens,
        AuthSessions sessions,
        IEmailSender mail,
        CancellationToken cancellationToken)
    {
        var email = Validation.NormalizeEmail(request.Email);
        if (email is not null && await users.FindByEmailAsync(email, cancellationToken) is { } user)
        {
            var token = await emailTokens.CreateAsync(user.Id, EmailTokenDocument.PurposeReset, cancellationToken);
            await mail.SendAsync(EmailTemplates.Reset(user.Email, user.Language, sessions.WebLink("/reset", token)), cancellationToken);
        }

        return Results.NoContent();
    }

    private static async Task<IResult> ResetAsync(
        ResetPasswordRequest request,
        UserStore users,
        EmailTokenStore emailTokens,
        RefreshTokenStore refreshTokens,
        TimeProvider clock,
        HttpContext http,
        CancellationToken cancellationToken)
    {
        if (Passwords.Validate(request.Password) is { } passwordError)
        {
            return Validation.ValidationProblem("password", passwordError);
        }

        var userId = await emailTokens.ConsumeAsync(request.Token ?? "", EmailTokenDocument.PurposeReset, cancellationToken);
        if (userId is null)
        {
            return Validation.Problem(StatusCodes.Status400BadRequest, "Invalid or expired reset link", code: "invalidToken");
        }

        // The link proves the mailbox, so an unconfirmed account is confirmed as a side effect.
        if (!await users.SetPasswordHashAsync(userId, PasswordHasher.Hash(request.Password!), confirmEmail: true, clock.GetUtcNow().UtcDateTime, cancellationToken))
        {
            return Validation.Problem(StatusCodes.Status400BadRequest, "Invalid or expired reset link", code: "invalidToken");
        }

        await refreshTokens.RevokeAllAsync(userId, RevokedReasons.PasswordReset, null, cancellationToken);
        AuthSessions.ClearCookie(http);
        return Results.NoContent();
    }

    private static async Task<IResult> ChangePasswordAsync(
        ChangePasswordRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        RefreshTokenStore refreshTokens,
        TimeProvider clock,
        HttpContext http,
        CancellationToken cancellationToken)
    {
        if (Passwords.Validate(request.NewPassword) is { } passwordError)
        {
            return Validation.ValidationProblem("newPassword", passwordError);
        }

        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        if (user is null)
        {
            return Validation.Unauthorized();
        }

        if (!PasswordHasher.Verify(request.CurrentPassword ?? "", user.PasswordHash))
        {
            return Validation.ValidationProblem("currentPassword", "Current password is wrong.");
        }

        await users.SetPasswordHashAsync(user.Id, PasswordHasher.Hash(request.NewPassword!), confirmEmail: false, clock.GetUtcNow().UtcDateTime, cancellationToken);

        // Other devices are logged out; the session that changed the password keeps its refresh token.
        var keep = AuthSessions.ReadCookie(http) is { } token ? (await refreshTokens.FindAsync(token, cancellationToken))?.Id : null;
        await refreshTokens.RevokeAllAsync(user.Id, RevokedReasons.PasswordChange, keep, cancellationToken);
        return Results.NoContent();
    }

    private static async Task<IResult> MeAsync(ClaimsPrincipal principal, UserStore users, AuthSessions sessions, CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(principal.RequireUserId(), cancellationToken);
        return user is null ? Validation.Unauthorized() : Results.Ok(await sessions.MeAsync(user, cancellationToken));
    }

    private static async Task SendConfirmationAsync(UserDocument user, EmailTokenStore emailTokens, AuthSessions sessions, IEmailSender mail, CancellationToken cancellationToken)
    {
        var token = await emailTokens.CreateAsync(user.Id, EmailTokenDocument.PurposeConfirm, cancellationToken);
        await mail.SendAsync(EmailTemplates.Confirm(user.Email, user.Language, sessions.WebLink("/confirm", token)), cancellationToken);
    }
}
