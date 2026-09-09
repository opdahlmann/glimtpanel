namespace Glimt.Hub.Infrastructure.Servers;

/// <summary>
/// Events the Servers feature raises that the Agents feature must act on (the agent side owns the sockets).
/// Implemented in Features/Agents (step 2.5); the Servers endpoints (step 2.4) only call it.
/// </summary>
public interface IServerLifecycle
{
    /// <summary>The server was deleted: close the agent socket with authFailed/serverRemoved and forget the session.</summary>
    Task ServerRemovedAsync(string serverId, CancellationToken cancellationToken);

    /// <summary>A new token was issued: push `rotate` to a connected agent; the old token stays valid for 10 minutes.</summary>
    Task TokenRotatedAsync(string serverId, string newToken, string newTokenHash, CancellationToken cancellationToken);
}

internal sealed class NullServerLifecycle : IServerLifecycle
{
    public Task ServerRemovedAsync(string serverId, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task TokenRotatedAsync(string serverId, string newToken, string newTokenHash, CancellationToken cancellationToken) => Task.CompletedTask;
}
