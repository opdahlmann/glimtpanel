using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Buffer;
using Glimt.Hub.Infrastructure.Servers;

namespace Glimt.Hub.Features.Agents;

/// <summary>
/// Reacts to the Servers endpoints: a deleted server is told authFailed/serverRemoved and forgotten, a
/// rotated key is pushed to the agent while the old token stays valid for 10 minutes (in this process;
/// after a hub restart only the new token is found in the servers collection).
/// </summary>
public sealed class AgentLifecycle(
    AgentRegistry registry,
    BufferStore buffer,
    SubscriptionCounter subscriptions,
    LogRelay logs,
    ILivePublisher live,
    AlertEngine alerts,
    IAlertStore alertStore,
    TimeProvider clock,
    ILogger<AgentLifecycle> logger) : IServerLifecycle
{
    public async Task ServerRemovedAsync(string serverId, CancellationToken cancellationToken)
    {
        await alerts.ForgetAsync(serverId, cancellationToken);
        await alertStore.DeleteByServerAsync(serverId, cancellationToken);
        if (!registry.TryGet(serverId, out var session))
        {
            buffer.Remove(serverId);
            return;
        }

        var ownerId = session.OwnerId;
        if (session.Link is { } link)
        {
            try
            {
                await link.SendAsync(new AuthFailed(AuthFailures.ServerRemoved), cancellationToken);
                // The close handshake waits up to 2 s for the agent; the caller (DELETE /api/servers/{id}) should not.
                _ = link.CloseAsync(AuthFailures.ServerRemoved, CancellationToken.None);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogDebug("closing agent {ServerId} after removal failed: {Error}", serverId, ex.Message);
            }
        }

        await logs.AgentGoneAsync(serverId, "server removed");
        subscriptions.Forget(serverId);
        registry.Remove(serverId);
        buffer.Remove(serverId);
        logger.LogInformation("server {ServerId} removed from the registry", serverId);
        await live.ServerRemovedAsync(serverId, ownerId, cancellationToken);
    }

    public async Task TokenRotatedAsync(string serverId, string newToken, string newTokenHash, CancellationToken cancellationToken)
    {
        if (!registry.TryGet(serverId, out var session))
        {
            // Never connected since the hub started: the new hash is in the servers collection already
            // and the next hello with the new token resumes from there.
            return;
        }

        session.RotateToken(newTokenHash, clock.GetUtcNow());
        if (session.Link is { } link)
        {
            try
            {
                await link.SendAsync(new Rotate(newToken), cancellationToken);
                logger.LogInformation("rotate sent to {ServerId}", serverId);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("rotate to {ServerId} failed: {Error}", serverId, ex.Message);
            }
        }
    }
}
