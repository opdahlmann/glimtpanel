using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Agents;

/// <summary>Outcome of a hello: either a session (plus a new token when enrolling) or a failure reason.</summary>
public sealed record AuthResult(AgentSession? Session, string? NewToken, string? Failure, bool IsNew = false)
{
    public static AuthResult Failed(string reason) => new(null, null, reason);
}

/// <summary>Resolves a hello to a server: dev enrol key, one-time enrol keys or a known token.</summary>
public sealed class AgentAuthenticator(
    GlimtOptions options,
    AgentRegistry registry,
    IServerStore store,
    IEnrolKeyStore enrolKeys,
    UserDirectory users,
    TimeProvider clock)
{
    public async Task<AuthResult> AuthenticateAsync(Hello hello, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrEmpty(hello.EnrolKey))
        {
            return await EnrolAsync(hello, cancellationToken);
        }

        if (!string.IsNullOrEmpty(hello.Token))
        {
            return await ResumeAsync(hello.Token, cancellationToken);
        }

        return AuthResult.Failed(AuthFailures.InvalidKey);
    }

    private async Task<AuthResult> EnrolAsync(Hello hello, CancellationToken cancellationToken)
    {
        if (options.IsDevelopmentLike
            && options.DevEnrolKey is { Length: > 0 } devKey
            && AgentTokens.FixedTimeEquals(hello.EnrolKey!, devKey))
        {
            var session = registry.GetOrAdd(ServerIds.ForDev(hello.Hostname), out var added);
            session.OwnerId ??= await users.DevUserIdAsync(cancellationToken);
            var token = AgentTokens.Generate();
            session.RotateToken(AgentTokens.Hash(token), clock.GetUtcNow());
            return new AuthResult(session, token, null, added);
        }

        // One-time key from POST /api/servers/enrol-key (collection enrolKeys). The store answers null for
        // unknown, expired and already used keys alike, so the agent always sees invalidKey.
        var info = await enrolKeys.TryConsumeAsync(hello.EnrolKey!, cancellationToken);
        if (info is null)
        {
            return AuthResult.Failed(AuthFailures.InvalidKey);
        }

        var newSession = registry.GetOrAdd(ServerIds.New());
        newSession.OwnerId = info.OwnerId;
        var newToken = AgentTokens.Generate();
        newSession.RotateToken(AgentTokens.Hash(newToken), clock.GetUtcNow());
        return new AuthResult(newSession, newToken, null, IsNew: true);
    }

    private async Task<AuthResult> ResumeAsync(string token, CancellationToken cancellationToken)
    {
        var hash = AgentTokens.Hash(token);
        var now = clock.GetUtcNow();
        var session = registry.FindByTokenHash(hash, now);
        if (session is null)
        {
            // Not seen since the hub started: the token may still be valid in the servers collection.
            // Only the current tokenHash can be looked up there; a previous token (10-minute grace after a
            // rotate) is only known while the hub that performed the rotate is running.
            var doc = await store.FindByTokenHashAsync(hash, cancellationToken);
            if (doc is not null)
            {
                session = registry.GetOrAdd(doc.Id);
                if (session.TokenHash.Length == 0)
                {
                    session.Restore(doc);
                }
            }
        }

        return session is null ? AuthResult.Failed(AuthFailures.InvalidToken) : new AuthResult(session, null, null);
    }
}
