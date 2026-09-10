using Glimt.Hub.Features.Access;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Demo;

/// <summary>Outcome of <see cref="E2eUsers.EnsureAsync"/>: the user, or an HTTP status with a reason.</summary>
public sealed record EnsureUserResult(int Status, string? Id, string? Email, bool Created, bool Reader, string? Error)
{
    public static EnsureUserResult Fail(int status, string error) => new(status, null, null, false, false, error);
}

/// <summary>
/// POST /api/e2e/ensure-user: a confirmed account with a known password for the Playwright screens that the dev
/// user cannot show: an owner without servers (screen 3) and a reader (screen 18). `readerOf: "all"` inserts an
/// accepted grant from the owner of the demo servers, so the reader sees the 16 fake servers and nothing else.
/// Idempotent: an existing account is left as it is (the password is not changed).
/// </summary>
public sealed class E2eUsers(UserStore users, AccessGrantStore grants, FakeAgentService demo, MongoContext mongo, TimeProvider clock)
{
    public const string DefaultPassword = "GlimtE2E-2026!";

    public async Task<EnsureUserResult> EnsureAsync(string? email, string? password, string? readerOf, CancellationToken cancellationToken)
    {
        email = Validation.NormalizeEmail(email);
        if (email is null)
        {
            return EnsureUserResult.Fail(StatusCodes.Status400BadRequest, "a valid email is required");
        }

        if (readerOf is not null && !string.Equals(readerOf, GrantScopes.All, StringComparison.OrdinalIgnoreCase))
        {
            return EnsureUserResult.Fail(StatusCodes.Status400BadRequest, "readerOf must be \"all\" (or omitted)");
        }

        if (!mongo.IsAvailable)
        {
            return EnsureUserResult.Fail(StatusCodes.Status503ServiceUnavailable, "MongoDB is not available");
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var created = false;
        var user = await users.FindByEmailAsync(email, cancellationToken);
        if (user is null)
        {
            user = new UserDocument
            {
                Email = email,
                Name = "E2E " + email[..email.IndexOf('@')],
                PasswordHash = PasswordHasher.Hash(string.IsNullOrEmpty(password) ? DefaultPassword : password),
                EmailConfirmedAt = now,
                Plan = "beta",
                Timezone = "Europe/Oslo",
                Language = "en",
                CreatedAt = now,
            };
            created = await users.TryInsertAsync(user, cancellationToken);
            if (!created)
            {
                user = await users.FindByEmailAsync(email, cancellationToken);
                if (user is null)
                {
                    return EnsureUserResult.Fail(StatusCodes.Status500InternalServerError, "could not create the user");
                }
            }
        }

        var reader = false;
        if (readerOf is not null)
        {
            var grant = new AccessGrantDocument
            {
                OwnerId = demo.OwnerId,
                Email = email,
                UserId = user.Id,
                Scope = GrantScopes.All,
                Status = GrantStatuses.Accepted,
                CreatedAt = now,
                AcceptedAt = now,
            };
            // false = the owner already granted this e-mail (unique index); that is the state we want.
            await grants.TryInsertAsync(grant, cancellationToken);
            reader = true;
        }

        return new EnsureUserResult(StatusCodes.Status200OK, user.Id, user.Email, created, reader, null);
    }
}
