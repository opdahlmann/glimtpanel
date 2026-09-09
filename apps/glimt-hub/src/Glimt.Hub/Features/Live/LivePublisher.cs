using System.Collections.Concurrent;
using System.Diagnostics;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;
using Glimt.Hub.Features.Buffer;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Access;
using Microsoft.AspNetCore.SignalR;

namespace Glimt.Hub.Features.Live;

/// <summary>
/// Fans agent events out over SignalR: Card/ServerStatus/ServerAdded/ServerRemoved to the user:{id}
/// groups of everyone who can see the server, Server to the server:{id} group, log lines to the one
/// connection that owns the stream.
/// </summary>
internal sealed class LivePublisher(
    IHubContext<LiveHub, ILiveClient> hub,
    LiveConnections connections,
    SubscriptionCounter subscriptions,
    BufferStore buffers,
    IAccessService access,
    UserDirectory users,
    GlimtOptions options,
    TimeProvider clock,
    ILogger<LivePublisher> logger) : ILivePublisher, ILogReceiver
{
    /// <summary>
    /// At most one Card per server per second. 900 ms rather than 1 000 so a 1 s stream (which arrives at
    /// 999–1 001 ms) yields one Card per frame instead of every other one.
    /// </summary>
    public static readonly TimeSpan CardThrottle = TimeSpan.FromMilliseconds(900);

    private static readonly TimeSpan AccessCacheFor = TimeSpan.FromSeconds(30);

    private readonly ConcurrentDictionary<string, long> _lastCard = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (string[] Ids, long At)> _accessCache = new(StringComparer.Ordinal);

    public async Task StatusAsync(AgentSession session, CancellationToken cancellationToken)
    {
        await RefreshOverviewAsync(session, cancellationToken);
        var groups = await UserGroupsAsync(session.ServerId, session.OwnerId, cancellationToken);
        if (groups.Count == 0)
        {
            return;
        }

        await hub.Clients.Groups(groups).ServerStatus(ServerStatusDto.From(session));
        await SendCardAsync(session, groups, force: true);
    }

    public async Task ServerAddedAsync(AgentSession session, CancellationToken cancellationToken)
    {
        await RefreshOverviewAsync(session, cancellationToken);
        var groups = await UserGroupsAsync(session.ServerId, session.OwnerId, cancellationToken);
        if (groups.Count > 0)
        {
            await hub.Clients.Groups(groups).ServerAdded(Projections.Card(session, buffers.Get(session.ServerId), clock.GetUtcNow()));
        }
    }

    public async Task ServerRemovedAsync(string serverId, string? ownerId, CancellationToken cancellationToken)
    {
        var groups = await UserGroupsAsync(serverId, ownerId, cancellationToken);
        connections.ForgetServer(serverId);
        _accessCache.TryRemove(serverId, out _);
        _lastCard.TryRemove(serverId, out _);
        if (groups.Count > 0)
        {
            await hub.Clients.Groups(groups).ServerRemoved(serverId);
        }
    }

    public async Task SnapshotAsync(AgentSession session, CancellationToken cancellationToken)
    {
        // TODO(optimisation): send only the snapshot-only sections when a stream is running (snapshotVersion).
        await hub.Clients.Group(LiveHub.ServerGroup(session.ServerId)).Server(Projections.Server(session));
        await SendCardAsync(session, await UserGroupsAsync(session.ServerId, session.OwnerId, cancellationToken), force: false);
    }

    public async Task StreamAsync(AgentSession session, CancellationToken cancellationToken)
    {
        await hub.Clients.Group(LiveHub.ServerGroup(session.ServerId)).Server(Projections.Server(session));
        await SendCardAsync(session, await UserGroupsAsync(session.ServerId, session.OwnerId, cancellationToken), force: false);
    }

    public Task LogAsync(string connectionId, string streamId, IReadOnlyList<LogLine> lines, int? dropped, CancellationToken cancellationToken) =>
        hub.Clients.Client(connectionId).Log(streamId, lines, dropped);

    public Task LogEndedAsync(string connectionId, string streamId, string reason, string? message, CancellationToken cancellationToken) =>
        hub.Clients.Client(connectionId).LogEnded(streamId, reason, message);

    private async Task SendCardAsync(AgentSession session, IReadOnlyList<string> groups, bool force)
    {
        if (groups.Count == 0)
        {
            return;
        }

        var now = Stopwatch.GetTimestamp();
        if (!force && _lastCard.TryGetValue(session.ServerId, out var last) && Stopwatch.GetElapsedTime(last, now) < CardThrottle)
        {
            return;
        }

        _lastCard[session.ServerId] = now;
        await hub.Clients.Groups(groups).Card(Projections.Card(session, buffers.Get(session.ServerId), clock.GetUtcNow()));
    }

    /// <summary>
    /// user:{id} groups for: the access service's readers (cached 30 s), the owner, the dev user for
    /// ownerless servers in development, and every overview subscriber whose visible set has the server.
    /// </summary>
    private async Task<IReadOnlyList<string>> UserGroupsAsync(string serverId, string? ownerId, CancellationToken cancellationToken)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in await AccessIdsAsync(serverId, cancellationToken))
        {
            ids.Add(id);
        }

        if (ownerId is not null)
        {
            ids.Add(ownerId);
        }
        else if (options.IsDevelopmentLike && await users.DevUserIdAsync(cancellationToken) is { } dev)
        {
            ids.Add(dev);
        }

        ids.UnionWith(connections.OverviewUsersSeeing(serverId));
        return ids.Select(LiveHub.UserGroup).ToArray();
    }

    private async Task<string[]> AccessIdsAsync(string serverId, CancellationToken cancellationToken)
    {
        var now = Stopwatch.GetTimestamp();
        if (_accessCache.TryGetValue(serverId, out var hit) && Stopwatch.GetElapsedTime(hit.At, now) < AccessCacheFor)
        {
            return hit.Ids;
        }

        try
        {
            var ids = (await access.UserIdsWithAccessAsync(serverId, cancellationToken)).ToArray();
            _accessCache[serverId] = (ids, now);
            return ids;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug("access lookup for {ServerId} failed: {Error}", serverId, ex.Message);
            return [];
        }
    }

    /// <summary>A server the overview subscribers have not seen yet: ask the access service and extend their visible set.</summary>
    private async Task RefreshOverviewAsync(AgentSession session, CancellationToken cancellationToken)
    {
        foreach (var (connectionId, userId) in connections.OverviewConnectionsMissing(session.ServerId))
        {
            try
            {
                if (await access.CanReadAsync(userId, session.ServerId, cancellationToken))
                {
                    connections.AddVisible(connectionId, session.ServerId);
                    await subscriptions.SubscribeOverviewAsync(connectionId, [session.ServerId], cancellationToken);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogDebug("access check for {UserId} on {ServerId} failed: {Error}", userId, session.ServerId, ex.Message);
            }
        }
    }
}
