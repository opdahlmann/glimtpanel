using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Agents;

/// <summary>Outcome of a hello: either a session (plus a new token when enrolling) or a failure reason.</summary>
public sealed record AuthResult(AgentSession? Session, string? NewToken, string? Failure)
{
    public static AuthResult Failed(string reason) => new(null, null, reason);
}

/// <summary>Resolves a hello to a server: dev enrol key, one-time enrol keys (later) or a known token.</summary>
public sealed class AgentAuthenticator(GlimtOptions options, AgentRegistry registry, IServerStore store)
{
    public async Task<AuthResult> AuthenticateAsync(Hello hello, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrEmpty(hello.EnrolKey))
        {
            return Enrol(hello);
        }

        if (!string.IsNullOrEmpty(hello.Token))
        {
            return await ResumeAsync(hello.Token, cancellationToken);
        }

        return AuthResult.Failed(AuthFailures.InvalidKey);
    }

    private AuthResult Enrol(Hello hello)
    {
        if (options.IsDevelopmentLike
            && options.DevEnrolKey is { Length: > 0 } devKey
            && AgentTokens.FixedTimeEquals(hello.EnrolKey!, devKey))
        {
            var session = registry.GetOrAdd(ServerIds.ForDev(hello.Hostname));
            var token = AgentTokens.Generate();
            session.TokenHash = AgentTokens.Hash(token);
            return new AuthResult(session, token, null);
        }

        // TODO(step 2.4): look up one-time keys in the Mongo `enrolKeys` collection (keyHash, ownerId,
        // dockerMode, expiresAt, usedAt); answer expiredKey when the TTL has passed and mark usedAt.
        return AuthResult.Failed(AuthFailures.InvalidKey);
    }

    private async Task<AuthResult> ResumeAsync(string token, CancellationToken cancellationToken)
    {
        var hash = AgentTokens.Hash(token);
        var session = registry.FindByTokenHash(hash);
        if (session is null)
        {
            // Not seen since the hub started: the token may still be valid in the servers collection.
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

        // TODO(step 2.4): also accept previousTokenHash for 10 minutes after a rotate.
        return session is null ? AuthResult.Failed(AuthFailures.InvalidToken) : new AuthResult(session, null, null);
    }
}
