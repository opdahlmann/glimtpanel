using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Buffer;
using Glimt.Hub.Infrastructure.Access;
using Glimt.Hub.Infrastructure.Auth;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace Glimt.Hub.Features.Live;

/// <summary>
/// SignalR hub at /hub/live (IMPLEMENTERINGSPLAN 4.3). JWT from the access_token query string (or the
/// Authorization header); Context.UserIdentifier is the user id. Overview subscribers sit in user:{id},
/// server-page subscribers in server:{id}; the SubscriptionCounter turns that into subscribe/unsubscribe
/// to the agents, and the LogRelay binds log streams to this connection.
/// </summary>
[Authorize]
public sealed class LiveHub(
    AgentRegistry registry,
    LiveConnections connections,
    SubscriptionCounter subscriptions,
    LogRelay logs,
    BufferStore buffers,
    ActiveAlertCounts alerts,
    IAccessService access,
    TimeProvider clock) : Hub<ILiveClient>
{
    public const string Path = "/hub/live";

    public static string UserGroup(string userId) => "user:" + userId;

    public static string ServerGroup(string serverId) => "server:" + serverId;

    /// <summary>Every connection of a user, whatever page it shows: `Alert(event)` goes here (step 7.1).</summary>
    public static string AlertGroup(string userId) => "alerts:" + userId;

    private string UserId => Context.UserIdentifier ?? Context.User?.GetUserId() ?? throw new HubException("unauthenticated");

    public override async Task OnConnectedAsync()
    {
        connections.Connected(Context.ConnectionId, UserId);
        await Groups.AddToGroupAsync(Context.ConnectionId, AlertGroup(UserId), Context.ConnectionAborted);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        connections.Disconnected(Context.ConnectionId);
        await logs.StopAllAsync(Context.ConnectionId, CancellationToken.None);
        await subscriptions.RemoveConnectionAsync(Context.ConnectionId, CancellationToken.None);
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>Joins user:{id} and immediately sends a Card (and ServerStatus) for every server the user may see.</summary>
    public async Task SubscribeOverview()
    {
        var userId = UserId;
        var ct = Context.ConnectionAborted;
        await Groups.AddToGroupAsync(Context.ConnectionId, UserGroup(userId), ct);
        var visible = await access.VisibleServerIdsAsync(userId, ct);
        connections.SetOverview(Context.ConnectionId, visible);
        await subscriptions.SubscribeOverviewAsync(Context.ConnectionId, visible, ct);

        var now = clock.GetUtcNow();
        foreach (var id in visible)
        {
            if (registry.TryGet(id, out var session))
            {
                await Clients.Caller.ServerStatus(ServerStatusDto.From(session));
                await Clients.Caller.Card(Projections.Card(session, buffers.Get(id), now, alerts.Get(id)));
            }
        }
    }

    public async Task UnsubscribeOverview()
    {
        var ct = Context.ConnectionAborted;
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, UserGroup(UserId), ct);
        connections.ClearOverview(Context.ConnectionId);
        await subscriptions.UnsubscribeOverviewAsync(Context.ConnectionId, ct);
    }

    /// <summary>Joins server:{id} after an access check and sends the current Server projection.</summary>
    public async Task SubscribeServer(string id)
    {
        var ct = Context.ConnectionAborted;
        await RequireReadAsync(id, ct);
        await Groups.AddToGroupAsync(Context.ConnectionId, ServerGroup(id), ct);
        await subscriptions.SubscribeServerAsync(Context.ConnectionId, id, ct);
        if (registry.TryGet(id, out var session))
        {
            await Clients.Caller.Server(Projections.Server(session));
        }
    }

    public async Task UnsubscribeServer(string id)
    {
        var ct = Context.ConnectionAborted;
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, ServerGroup(id), ct);
        await subscriptions.UnsubscribeServerAsync(Context.ConnectionId, id, ct);
    }

    /// <summary>1000 while the page is active, 5000 after two minutes without interaction.</summary>
    public Task SetInterval(int ms)
    {
        if (!SubscriptionCounter.AllowedIntervals.Contains(ms))
        {
            throw new HubException("interval must be 1000 or 5000");
        }

        return subscriptions.SetIntervalAsync(Context.ConnectionId, ms, Context.ConnectionAborted);
    }

    /// <summary>Opens a log stream on the server; lines arrive as Log(streamId, …) on this connection only.</summary>
    public async Task<string> StartLog(LogRequest request)
    {
        if (request is null || string.IsNullOrEmpty(request.ServerId) || string.IsNullOrEmpty(request.Source))
        {
            throw new HubException("serverId and source are required");
        }

        var ct = Context.ConnectionAborted;
        await RequireReadAsync(request.ServerId, ct);
        return await logs.StartAsync(Context.ConnectionId, request, ct);
    }

    public Task StopLog(string streamId) => logs.StopAsync(Context.ConnectionId, streamId, Context.ConnectionAborted);

    private async Task RequireReadAsync(string serverId, CancellationToken ct)
    {
        if (!await access.CanReadAsync(UserId, serverId, ct))
        {
            throw new HubException("forbidden");
        }
    }
}
