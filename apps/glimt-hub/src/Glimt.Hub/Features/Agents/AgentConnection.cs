using System.Buffers;
using System.Net.WebSockets;
using System.Text.Json;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Agents;

/// <summary>
/// One instance per agent socket. Reads text frames (max 1 MB), requires a hello within 10 s,
/// authenticates, answers welcome/authFailed, feeds every later frame to <see cref="AgentIngest"/> and
/// keeps the session alive with pings. Also the session's <see cref="IAgentLink"/> for outbound messages.
/// </summary>
public sealed class AgentConnection(
    AgentAuthenticator authenticator,
    AgentIngest ingest,
    GlimtOptions options,
    TimeProvider clock,
    IHostApplicationLifetime lifetime,
    ILogger<AgentConnection> logger) : IAgentLink
{
    public const int MaxMessageBytes = 1024 * 1024;
    public const int MaintenanceIntervalMs = 600_000;

    private static readonly TimeSpan HelloTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan WarnEvery = TimeSpan.FromMinutes(1);

    private readonly string _connectionId = Guid.NewGuid().ToString("N")[..12];
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly Dictionary<string, long> _lastWarned = new(StringComparer.Ordinal);
    private WebSocket? _socket;
    private DateTimeOffset _lastActivity;

    public string ConnectionId => _connectionId;

    public async Task RunAsync(WebSocket socket, string remote, CancellationToken requestAborted)
    {
        _socket = socket;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(requestAborted, lifetime.ApplicationStopping);
        var cancellation = cts.Token;
        // Cancelling a pending ReceiveAsync aborts the socket, so shutdown is done by closing the
        // output side instead; the peer's close frame then ends the receive loop cleanly.
        using var shutdown = cancellation.Register(() => _ = ShutdownAsync(socket, WebSocketCloseStatus.EndpointUnavailable, "hub shutting down"));

        AgentSession? session = null;
        _lastActivity = clock.GetUtcNow();
        try
        {
            var first = await ReceiveAsync(socket, HelloTimeout);
            if (first is null)
            {
                logger.LogDebug("agent connection {ConnectionId} from {Remote} closed before hello", _connectionId, remote);
                return;
            }

            if (first.Message is not Hello hello)
            {
                logger.LogWarning("agent connection {ConnectionId} from {Remote} sent {Type} instead of hello", _connectionId, remote, first.Type);
                await CloseAsync(socket, WebSocketCloseStatus.PolicyViolation, "hello expected");
                return;
            }

            if (hello.V != 1)
            {
                logger.LogWarning("agent connection {ConnectionId} from {Remote} uses unsupported protocol v{Version}", _connectionId, remote, hello.V);
                await CloseAsync(socket, WebSocketCloseStatus.PolicyViolation, "unsupported protocol version");
                return;
            }

            var auth = await authenticator.AuthenticateAsync(hello, cancellation);
            if (auth.Session is null)
            {
                logger.LogWarning("agent {Hostname} from {Remote} rejected: {Reason}", hello.Hostname, remote, auth.Failure);
                await SendAsync(socket, new AuthFailed(auth.Failure!), cancellation);
                await CloseAsync(socket, WebSocketCloseStatus.PolicyViolation, auth.Failure!);
                return;
            }

            session = auth.Session;
            var replaced = session.Attach(this, hello, clock.GetUtcNow());
            if (replaced is not null)
            {
                logger.LogInformation("agent {ServerId} reconnected; closing the previous connection {Previous}", session.ServerId, replaced.ConnectionId);
                _ = replaced.CloseAsync("replaced by a newer connection", CancellationToken.None);
            }

            await SendAsync(socket, new Welcome(session.ServerId, auth.NewToken, options.HeartbeatSeconds * 1000, MaintenanceIntervalMs), cancellation);
            logger.LogInformation(
                "agent {ServerId} ({Hostname}, v{AgentVersion}) connected from {Remote}{Enrolled}",
                session.ServerId, session.Hostname, session.AgentVersion, remote, auth.NewToken is null ? "" : " (enrolled)");

            await ingest.ConnectedAsync(session, auth.IsNew, cancellation);

            using var pingCts = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            var pingLoop = PingLoopAsync(socket, session, pingCts.Token);
            try
            {
                while (true)
                {
                    Envelope? envelope;
                    try
                    {
                        envelope = await ReceiveAsync(socket, null);
                    }
                    catch (Exception ex) when (ex is JsonException or ProtocolException)
                    {
                        Warn("invalid", session, "sent an invalid message: " + ex.Message);
                        continue;
                    }

                    if (envelope is null)
                    {
                        break;
                    }

                    await HandleAsync(session, envelope, cancellation);
                }
            }
            finally
            {
                pingCts.Cancel();
                await pingLoop;
            }
        }
        catch (OperationCanceledException)
        {
            logger.LogDebug("agent connection {ConnectionId} cancelled", _connectionId);
        }
        catch (WebSocketException ex)
        {
            logger.LogInformation("agent connection {ConnectionId} ({ServerId}) lost: {Error}", _connectionId, session?.ServerId ?? "-", ex.Message);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "agent connection {ConnectionId} ({ServerId}) failed", _connectionId, session?.ServerId ?? "-");
        }
        finally
        {
            if (session is not null && session.Detach(_connectionId))
            {
                logger.LogInformation("agent {ServerId} ({Hostname}) disconnected", session.ServerId, session.Hostname);
                await ingest.DisconnectedAsync(session);
            }

            await CloseAsync(socket, WebSocketCloseStatus.NormalClosure, "bye");
        }
    }

    private async Task HandleAsync(AgentSession session, Envelope envelope, CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        _lastActivity = now;
        switch (envelope.Message)
        {
            case Pong:
                session.Touch(now);
                break;
            case Snapshot snapshot:
                await ingest.SnapshotAsync(session, snapshot, cancellationToken);
                break;
            case Protocol.Stream stream:
                await ingest.StreamAsync(session, stream, cancellationToken);
                break;
            case Log log:
                session.Touch(now);
                await ingest.LogAsync(session, log, cancellationToken);
                break;
            case LogEnd end:
                session.Touch(now);
                await ingest.LogEndAsync(session, end, cancellationToken);
                break;
            case Bye bye:
                await ingest.ByeAsync(session, bye, cancellationToken);
                break;
            case Hello:
                Warn("hello", session, "sent a second hello; ignored");
                break;
            case null:
                Warn("unknown:" + envelope.Type, session, "sent unknown message type '" + envelope.Type + "'; ignored");
                break;
            default:
                Warn("direction:" + envelope.Type, session, "sent hub-to-agent message type '" + envelope.Type + "'; ignored");
                break;
        }
    }

    /// <summary>Logs at most once per minute per key per agent so a chatty agent cannot flood the log.</summary>
    private void Warn(string key, AgentSession session, string text)
    {
        var now = Environment.TickCount64;
        if (_lastWarned.TryGetValue(key, out var last) && now - last < WarnEvery.TotalMilliseconds)
        {
            return;
        }

        _lastWarned[key] = now;
        logger.LogWarning("agent {ServerId} {Message}", session.ServerId, text);
    }

    // ---- IAgentLink ---------------------------------------------------------------------------

    public Task SendAsync(AgentMessage message, CancellationToken cancellationToken = default) =>
        _socket is { } socket ? SendAsync(socket, message, cancellationToken) : Task.CompletedTask;

    public Task CloseAsync(string reason, CancellationToken cancellationToken = default) =>
        _socket is { } socket ? ShutdownAsync(socket, WebSocketCloseStatus.PolicyViolation, reason) : Task.CompletedTask;

    private async Task PingLoopAsync(WebSocket socket, AgentSession session, CancellationToken cancellationToken)
    {
        try
        {
            using var timer = new PeriodicTimer(options.Heartbeat, clock);
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                if (clock.GetUtcNow() - _lastActivity >= options.Heartbeat)
                {
                    await SendAsync(socket, new Ping(), cancellationToken);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // connection is going away
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException)
        {
            logger.LogDebug("ping to {ServerId} failed: {Error}", session.ServerId, ex.Message);
        }
    }

    /// <summary>Reads one complete text message. Returns null when the peer closed the socket.</summary>
    private async Task<Envelope?> ReceiveAsync(WebSocket socket, TimeSpan? timeout)
    {
        using var timeoutCts = timeout is { } t ? new CancellationTokenSource(t) : null;
        var token = timeoutCts?.Token ?? CancellationToken.None;
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        try
        {
            using var message = new MemoryStream();
            ValueWebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer.AsMemory(), token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return null;
                }

                if (result.MessageType == WebSocketMessageType.Binary)
                {
                    await CloseAsync(socket, WebSocketCloseStatus.InvalidMessageType, "text frames only");
                    return null;
                }

                if (message.Length + result.Count > MaxMessageBytes)
                {
                    logger.LogWarning("agent connection {ConnectionId} sent a frame above {Max} bytes", _connectionId, MaxMessageBytes);
                    await CloseAsync(socket, WebSocketCloseStatus.MessageTooBig, "max 1 MB per message");
                    return null;
                }

                message.Write(buffer, 0, result.Count);
            }
            while (!result.EndOfMessage);

            return ProtocolJson.Parse(new ReadOnlyMemory<byte>(message.GetBuffer(), 0, (int)message.Length));
        }
        catch (OperationCanceledException) when (timeoutCts is not null)
        {
            logger.LogWarning("agent connection {ConnectionId} sent no hello within {Timeout}s", _connectionId, HelloTimeout.TotalSeconds);
            return null;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private async Task SendAsync(WebSocket socket, AgentMessage message, CancellationToken cancellationToken)
    {
        var bytes = ProtocolJson.Serialize(message);
        await _sendLock.WaitAsync(cancellationToken);
        try
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>Completes the close handshake. Must not run while a receive is pending.</summary>
    private async Task CloseAsync(WebSocket socket, WebSocketCloseStatus status, string description)
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived))
        {
            return;
        }

        await _sendLock.WaitAsync();
        try
        {
            using var timeoutCts = new CancellationTokenSource(CloseTimeout);
            if (socket.State == WebSocketState.CloseReceived)
            {
                await socket.CloseOutputAsync(status, description, timeoutCts.Token);
            }
            else if (socket.State == WebSocketState.Open)
            {
                await socket.CloseAsync(status, description, timeoutCts.Token);
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or ObjectDisposedException)
        {
            socket.Abort();
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>
    /// Close from outside the receive loop (hub shutdown, request abort, server removed, replaced by a
    /// newer connection): send a close frame, then abort if the peer does not answer.
    /// </summary>
    private async Task ShutdownAsync(WebSocket socket, WebSocketCloseStatus status, string description)
    {
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await _sendLock.WaitAsync();
                try
                {
                    using var timeoutCts = new CancellationTokenSource(CloseTimeout);
                    await socket.CloseOutputAsync(status, description, timeoutCts.Token);
                }
                finally
                {
                    _sendLock.Release();
                }
            }

            await Task.Delay(CloseTimeout);
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or ObjectDisposedException)
        {
            // fall through to abort
        }

        if (socket.State is not (WebSocketState.Closed or WebSocketState.Aborted))
        {
            socket.Abort();
        }
    }
}
