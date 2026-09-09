using Glimt.Hub.Features.Agents.Protocol;

namespace Glimt.Hub.Features.Agents;

/// <summary>
/// What the agent side tells the browser side (implemented by the Live feature over SignalR):
/// status changes, new/removed servers and the Card/Server projections after every snapshot and stream.
/// </summary>
public interface ILivePublisher
{
    /// <summary>Connect, disconnect or down: ServerStatus and a fresh Card to everyone who can see the server.</summary>
    Task StatusAsync(AgentSession session, CancellationToken cancellationToken = default);

    /// <summary>A server the registry has not seen before (enrolment or first dev-key hello): ServerAdded to the owner.</summary>
    Task ServerAddedAsync(AgentSession session, CancellationToken cancellationToken = default);

    /// <summary>The server was deleted: ServerRemoved to everyone who could see it.</summary>
    Task ServerRemovedAsync(string serverId, string? ownerId, CancellationToken cancellationToken = default);

    /// <summary>A snapshot arrived (buffer already updated): Card to overview subscribers, Server to server subscribers.</summary>
    Task SnapshotAsync(AgentSession session, CancellationToken cancellationToken = default);

    /// <summary>A stream frame arrived: Server to server subscribers, Card (throttled to 1/s) to overview subscribers.</summary>
    Task StreamAsync(AgentSession session, CancellationToken cancellationToken = default);
}

/// <summary>Where relayed log lines go (the SignalR connection that opened the stream).</summary>
public interface ILogReceiver
{
    Task LogAsync(string connectionId, string streamId, IReadOnlyList<LogLine> lines, int? dropped, CancellationToken cancellationToken = default);

    Task LogEndedAsync(string connectionId, string streamId, string reason, string? message, CancellationToken cancellationToken = default);
}

/// <summary>The outbound side of one agent (a WebSocket, or the fake agent in demo mode).</summary>
public interface IAgentLink
{
    string ConnectionId { get; }

    Task SendAsync(AgentMessage message, CancellationToken cancellationToken = default);

    /// <summary>Closes the connection; the reason is only for the log.</summary>
    Task CloseAsync(string reason, CancellationToken cancellationToken = default);
}
