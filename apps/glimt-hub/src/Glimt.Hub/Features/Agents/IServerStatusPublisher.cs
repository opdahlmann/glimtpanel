namespace Glimt.Hub.Features.Agents;

/// <summary>Pushes a server's status to whoever is watching (implemented by the SignalR Live feature).</summary>
public interface IServerStatusPublisher
{
    Task PublishAsync(AgentSession session, CancellationToken cancellationToken = default);
}
