using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;

namespace Glimt.Hub.Features.Live;

/// <summary>Methods the hub calls on the browser (IMPLEMENTERINGSPLAN 4.3). Alert(event) arrives in step 7.1.</summary>
public interface ILiveClient
{
    Task ServerStatus(ServerStatusDto status);

    Task Card(CardDto card);

    Task Server(ServerDto server);

    Task Log(string streamId, IReadOnlyList<LogLine> lines, int? dropped);

    Task LogEnded(string streamId, string reason, string? message);

    Task ServerAdded(CardDto card);

    Task ServerRemoved(string id);
}
