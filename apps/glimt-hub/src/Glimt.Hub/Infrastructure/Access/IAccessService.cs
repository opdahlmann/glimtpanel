namespace Glimt.Hub.Infrastructure.Access;

/// <summary>
/// The one place access control is decided (IMPLEMENTERINGSPLAN 4.7). Every /api/servers endpoint and every
/// SignalR subscription goes through it. Owners see and change their own servers; readers (accessGrants)
/// see everything on the servers in their scope but change nothing.
/// </summary>
public interface IAccessService
{
    /// <summary>Servers the user may read: own servers plus servers granted through accessGrants.</summary>
    Task<IReadOnlyList<string>> VisibleServerIdsAsync(string userId, CancellationToken cancellationToken);

    Task<bool> CanReadAsync(string userId, string serverId, CancellationToken cancellationToken);

    Task<bool> IsOwnerAsync(string userId, string serverId, CancellationToken cancellationToken);

    /// <summary>All user ids (owner and readers) that may read the server; used to fan out live updates and alerts.</summary>
    Task<IReadOnlyList<string>> UserIdsWithAccessAsync(string serverId, CancellationToken cancellationToken);
}
