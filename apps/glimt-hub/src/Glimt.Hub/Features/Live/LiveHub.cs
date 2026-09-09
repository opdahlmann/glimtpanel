using Glimt.Hub.Features.Agents;
using Microsoft.AspNetCore.SignalR;

namespace Glimt.Hub.Features.Live;

/// <summary>Methods the hub calls on the browser (IMPLEMENTERINGSPLAN 4.3). More arrive in steps 2.7 and 7.1.</summary>
public interface ILiveClient
{
    Task ServerStatus(ServerStatusDto status);
}

/// <summary>
/// SignalR hub at /hub/live. Anonymous for now.
/// TODO(step 2.7): JWT authentication from the access_token query string, user:{id} groups, access checks,
/// SubscribeServer/SetInterval/StartLog and the Card/Server projections.
/// </summary>
public sealed class LiveHub(AgentRegistry registry) : Hub<ILiveClient>
{
    public const string Path = "/hub/live";
    public const string OverviewGroup = "overview";

    /// <summary>Joins the overview group and immediately sends the status of every known server.</summary>
    public async Task SubscribeOverview()
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, OverviewGroup, Context.ConnectionAborted);
        foreach (var session in registry.All)
        {
            await Clients.Caller.ServerStatus(ServerStatusDto.From(session));
        }
    }

    public Task UnsubscribeOverview() =>
        Groups.RemoveFromGroupAsync(Context.ConnectionId, OverviewGroup, Context.ConnectionAborted);
}

/// <summary>Broadcasts status changes from the agent side to the overview group.</summary>
internal sealed class LiveStatusPublisher(IHubContext<LiveHub, ILiveClient> hub) : IServerStatusPublisher
{
    public Task PublishAsync(AgentSession session, CancellationToken cancellationToken = default) =>
        hub.Clients.Group(LiveHub.OverviewGroup).ServerStatus(ServerStatusDto.From(session));
}
