using Glimt.Hub.Features.Agents.Protocol;

namespace Glimt.Hub.Features.Agents;

/// <summary>Reasons in <see cref="LogEnd"/> and LogEnded.</summary>
public static class LogEndReasons
{
    public const string Stopped = "stopped";
    public const string Unavailable = "unavailable";
    public const string Error = "error";
    public const string Eof = "eof";
}

/// <summary>What a browser asks for when it opens a log view (mirrors logStart minus the streamId).</summary>
public sealed record LogRequest(
    string ServerId,
    string Source,
    string? Unit = null,
    string? Container = null,
    string? Priority = null,
    long? SinceMs = null,
    int? Tail = null);

/// <summary>
/// Maps log streams to the one SignalR connection that opened them: logStart/logStop to the agent,
/// log/logEnd back to that connection only. Limits: 4 streams per connection, 8 per agent (step 2.7).
/// </summary>
public sealed class LogRelay(AgentRegistry registry, ILogReceiver receiver, ILogger<LogRelay> logger)
{
    public const int MaxPerConnection = 4;
    public const int MaxPerAgent = 8;
    public const int DefaultTail = 200;
    public static readonly string[] Sources = ["journal", "auth", "kernel", "packages", "web", "firewall", "container", "file"];

    private readonly Lock _lock = new();
    private readonly Dictionary<string, StreamEntry> _streams = new(StringComparer.Ordinal);

    private sealed record StreamEntry(string StreamId, string ServerId, string ConnectionId);

    public int Count
    {
        get
        {
            lock (_lock)
            {
                return _streams.Count;
            }
        }
    }

    /// <summary>Open streams per server id (GET /api/e2e/agent-streams: «no stream is left behind after the page is left»).</summary>
    public IReadOnlyDictionary<string, int> CountByServer()
    {
        lock (_lock)
        {
            return _streams.Values.GroupBy(s => s.ServerId, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        }
    }

    /// <summary>
    /// Opens a stream. Always returns a streamId; when the request cannot be served the connection
    /// receives LogEnded for that id right away (reason error or unavailable).
    /// </summary>
    public async Task<string> StartAsync(string connectionId, LogRequest request, CancellationToken cancellationToken)
    {
        var streamId = Guid.NewGuid().ToString("N");
        if (!Sources.Contains(request.Source))
        {
            await receiver.LogEndedAsync(connectionId, streamId, LogEndReasons.Error, $"unknown source '{request.Source}'", cancellationToken);
            return streamId;
        }

        if (!registry.TryGet(request.ServerId, out var session) || session.Link is not { } link)
        {
            await receiver.LogEndedAsync(connectionId, streamId, LogEndReasons.Unavailable, "agent is not connected", cancellationToken);
            return streamId;
        }

        lock (_lock)
        {
            var perConnection = _streams.Values.Count(s => s.ConnectionId == connectionId);
            var perAgent = _streams.Values.Count(s => s.ServerId == request.ServerId);
            if (perConnection >= MaxPerConnection || perAgent >= MaxPerAgent)
            {
                streamId = "";
            }
            else
            {
                _streams[streamId] = new StreamEntry(streamId, request.ServerId, connectionId);
            }
        }

        if (streamId.Length == 0)
        {
            streamId = Guid.NewGuid().ToString("N");
            await receiver.LogEndedAsync(connectionId, streamId, LogEndReasons.Error, "too many streams", cancellationToken);
            return streamId;
        }

        var start = new LogStart(
            streamId,
            request.Source,
            request.Unit,
            request.Container,
            null,
            request.Priority,
            request.SinceMs,
            request.Tail is > 0 and <= 1000 ? request.Tail : DefaultTail);
        try
        {
            await link.SendAsync(start, cancellationToken);
            logger.LogDebug("log stream {StreamId} started on {ServerId} for {ConnectionId} ({Source} {Unit}{Container})", streamId, request.ServerId, connectionId, request.Source, request.Unit, request.Container);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Remove(streamId);
            await receiver.LogEndedAsync(connectionId, streamId, LogEndReasons.Unavailable, ex.Message, cancellationToken);
        }

        return streamId;
    }

    /// <summary>Stops a stream the connection owns; the agent answers with logEnd stopped.</summary>
    public async Task StopAsync(string connectionId, string streamId, CancellationToken cancellationToken)
    {
        StreamEntry? entry;
        lock (_lock)
        {
            if (!_streams.TryGetValue(streamId, out entry) || entry.ConnectionId != connectionId)
            {
                return;
            }

            _streams.Remove(streamId);
        }

        await SendStopAsync(entry, cancellationToken);
        await receiver.LogEndedAsync(connectionId, streamId, LogEndReasons.Stopped, null, cancellationToken);
    }

    /// <summary>The browser connection is gone: every stream it had is stopped at the agent.</summary>
    public async Task StopAllAsync(string connectionId, CancellationToken cancellationToken)
    {
        foreach (var entry in Take(s => s.ConnectionId == connectionId))
        {
            await SendStopAsync(entry, cancellationToken);
        }
    }

    /// <summary>The agent disconnected (or was removed): its streams end with reason unavailable.</summary>
    public async Task AgentGoneAsync(string serverId, string message)
    {
        foreach (var entry in Take(s => s.ServerId == serverId))
        {
            await SafeEndAsync(entry, LogEndReasons.Unavailable, message);
        }
    }

    public async Task OnLogAsync(string serverId, Log log, CancellationToken cancellationToken)
    {
        if (Find(log.StreamId, serverId) is { } entry)
        {
            await receiver.LogAsync(entry.ConnectionId, log.StreamId, log.Lines, log.Dropped, cancellationToken);
        }
    }

    public async Task OnLogEndAsync(string serverId, LogEnd end, CancellationToken cancellationToken)
    {
        if (Find(end.StreamId, serverId) is { } entry)
        {
            Remove(end.StreamId);
            await receiver.LogEndedAsync(entry.ConnectionId, end.StreamId, end.Reason, end.Message, cancellationToken);
        }
    }

    private StreamEntry? Find(string streamId, string serverId)
    {
        lock (_lock)
        {
            return _streams.TryGetValue(streamId, out var entry) && entry.ServerId == serverId ? entry : null;
        }
    }

    private void Remove(string streamId)
    {
        lock (_lock)
        {
            _streams.Remove(streamId);
        }
    }

    private List<StreamEntry> Take(Func<StreamEntry, bool> predicate)
    {
        lock (_lock)
        {
            var taken = _streams.Values.Where(predicate).ToList();
            foreach (var entry in taken)
            {
                _streams.Remove(entry.StreamId);
            }

            return taken;
        }
    }

    private async Task SendStopAsync(StreamEntry entry, CancellationToken cancellationToken)
    {
        if (!registry.TryGet(entry.ServerId, out var session) || session.Link is not { } link)
        {
            return;
        }

        try
        {
            await link.SendAsync(new LogStop(entry.StreamId), cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug("logStop {StreamId} to {ServerId} failed: {Error}", entry.StreamId, entry.ServerId, ex.Message);
        }
    }

    private async Task SafeEndAsync(StreamEntry entry, string reason, string? message)
    {
        try
        {
            await receiver.LogEndedAsync(entry.ConnectionId, entry.StreamId, reason, message, CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogDebug("LogEnded {StreamId} to {ConnectionId} failed: {Error}", entry.StreamId, entry.ConnectionId, ex.Message);
        }
    }
}
