using Glimt.Hub.Features.Agents.Protocol;

namespace Glimt.Hub.Features.Agents;

/// <summary>A container node's link to the host agent that sees the same container (step 12.6).</summary>
public sealed record NodeLink(string HostId, string HostName, ContainerInfo Container);

/// <summary>
/// Links container nodes to host agents in memory: when a host's snapshot lists a container whose id starts with a
/// container node's <c>containerId</c> <b>and both belong to the same owner</b>, the node gets host name, image age,
/// state and restart count from the host, and the host's container row can point at the node. The link is gone as
/// soon as the host stops listing the container. Nothing is persisted.
/// </summary>
public sealed class NodeLinker(AgentRegistry registry)
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, NodeLink> _byNode = new(StringComparer.Ordinal);

    /// <summary>host id → (container id → node id).</summary>
    private readonly Dictionary<string, Dictionary<string, string>> _byHost = new(StringComparer.Ordinal);

    /// <summary>Recomputes the host's links from its snapshot and returns the nodes whose link appeared or disappeared.</summary>
    public IReadOnlyList<AgentSession> OnHostSnapshot(AgentSession host, Snapshot snapshot)
    {
        var candidates = host.OwnerId is null
            ? []
            : registry.All.Where(s => s.IsContainer && s.OwnerId == host.OwnerId && s.ContainerId is { Length: > 0 }).ToList();
        var changed = new List<AgentSession>();
        lock (_lock)
        {
            var previous = _byHost.GetValueOrDefault(host.ServerId) ?? new Dictionary<string, string>(StringComparer.Ordinal);
            var current = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var container in snapshot.Containers ?? [])
            {
                var node = candidates.FirstOrDefault(n => container.Id.StartsWith(n.ContainerId!, StringComparison.Ordinal));
                if (node is null)
                {
                    continue;
                }

                current[container.Id] = node.ServerId;
                var wasLinked = _byNode.TryGetValue(node.ServerId, out var old) && old.HostId == host.ServerId;
                _byNode[node.ServerId] = new NodeLink(host.ServerId, host.Name, container);
                if (!wasLinked)
                {
                    changed.Add(node);
                }
            }

            foreach (var (containerId, nodeId) in previous)
            {
                if (current.ContainsKey(containerId))
                {
                    continue;
                }

                if (_byNode.TryGetValue(nodeId, out var link) && link.HostId == host.ServerId && _byNode.Remove(nodeId) && registry.TryGet(nodeId, out var node))
                {
                    changed.Add(node);
                }
            }

            if (current.Count == 0)
            {
                _byHost.Remove(host.ServerId);
            }
            else
            {
                _byHost[host.ServerId] = current;
            }
        }

        return changed;
    }

    /// <summary>
    /// A container node connected: look at the last snapshot of every host with the same owner, so the link does not
    /// wait for the host's next snapshot. Returns true when the node got linked.
    /// </summary>
    public bool OnNodeConnected(AgentSession node)
    {
        if (!node.IsContainer || node.OwnerId is null || node.ContainerId is not { Length: > 0 })
        {
            return false;
        }

        foreach (var host in registry.All.Where(s => !s.IsContainer && s.OwnerId == node.OwnerId && s.LastSnapshot is not null))
        {
            OnHostSnapshot(host, host.LastSnapshot!);
        }

        return LinkOf(node.ServerId) is not null;
    }

    /// <summary>The host side of a container node, or null when no host agent sees it.</summary>
    public NodeLink? LinkOf(string nodeId)
    {
        lock (_lock)
        {
            return _byNode.GetValueOrDefault(nodeId);
        }
    }

    /// <summary>container id → node id for the host's containers that are container nodes (empty when none).</summary>
    public IReadOnlyDictionary<string, string>? LinkedNodes(string hostId)
    {
        lock (_lock)
        {
            return _byHost.TryGetValue(hostId, out var links) ? new Dictionary<string, string>(links, StringComparer.Ordinal) : null;
        }
    }

    /// <summary>A node or a host was removed from the registry.</summary>
    public void Forget(string serverId)
    {
        lock (_lock)
        {
            _byNode.Remove(serverId);
            if (_byHost.Remove(serverId, out var links))
            {
                foreach (var nodeId in links.Values)
                {
                    if (_byNode.TryGetValue(nodeId, out var link) && link.HostId == serverId)
                    {
                        _byNode.Remove(nodeId);
                    }
                }
            }
        }
    }
}
