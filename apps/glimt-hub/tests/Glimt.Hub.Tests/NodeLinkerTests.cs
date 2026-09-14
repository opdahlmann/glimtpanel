using System.Text.Json;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;
using Microsoft.Extensions.Logging.Abstractions;

namespace Glimt.Hub.Tests;

/// <summary>Host ↔ container node linking (IMPLEMENTERINGSPLAN step 12.6): match on containerId and owner, projections, stdout through the host, link gone when the container is.</summary>
public sealed class NodeLinkerTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 14, 8, 0, 0, TimeSpan.Zero);

    private sealed class RecordingReceiver : ILogReceiver
    {
        public List<(string ConnectionId, string StreamId, string Reason, string? Message)> Ended { get; } = [];

        public Task LogAsync(string connectionId, string streamId, IReadOnlyList<LogLine> lines, int? dropped, CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task LogEndedAsync(string connectionId, string streamId, string reason, string? message, CancellationToken cancellationToken = default)
        {
            Ended.Add((connectionId, streamId, reason, message));
            return Task.CompletedTask;
        }
    }

    private sealed class RecordingLink(string id) : IAgentLink
    {
        public string ConnectionId { get; } = id;

        public List<AgentMessage> Sent { get; } = [];

        public Task SendAsync(AgentMessage message, CancellationToken cancellationToken = default)
        {
            Sent.Add(message);
            return Task.CompletedTask;
        }

        public Task CloseAsync(string reason, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private static AgentSession Host(AgentRegistry registry, string id, string name, string owner, RecordingLink? link = null)
    {
        var session = registry.GetOrAdd(id);
        session.OwnerId = owner;
        session.SetIdentity(name, []);
        session.Attach(link ?? new RecordingLink("link-" + id), AlertEngineHarness.Hello(name), Now);
        return session;
    }

    private static AgentSession Node(AgentRegistry registry, string id, string name, string owner, string containerId)
    {
        var session = registry.GetOrAdd(id);
        session.OwnerId = owner;
        session.SetIdentity(name, []);
        session.Attach(new RecordingLink("link-" + id), AlertEngineHarness.ContainerHello(name, containerId), Now);
        return session;
    }

    private static Snapshot HostSnapshot(params (string Id, string Name, string State)[] containers) =>
        AlertEngineHarness.Snapshot(diskPct: 10, containers: containers.Select(c => AlertEngineHarness.Container(c.Name, c.State, 0, c.Id)));

    [Fact]
    public void Links_on_container_id_prefix_for_the_same_owner_only()
    {
        var registry = new AgentRegistry();
        var linker = new NodeLinker(registry);
        var host = Host(registry, "h1", "web-02", "owner-a");
        var node = Node(registry, "n1", "acme-backend", "owner-a", "abc123def456");
        var foreign = Node(registry, "n2", "other", "owner-b", "abc123def456");

        var changed = linker.OnHostSnapshot(host, HostSnapshot(("abc123def456789012", "web-api", "running"), ("fff", "web-db", "running")));
        Assert.Equal(["n1"], changed.Select(s => s.ServerId));
        var link = linker.LinkOf("n1");
        Assert.NotNull(link);
        Assert.Equal("h1", link.HostId);
        Assert.Equal("web-02", link.HostName);
        Assert.Equal("web-api", link.Container.Name);
        Assert.Null(linker.LinkOf("n2"));
        Assert.Equal(new Dictionary<string, string> { ["abc123def456789012"] = "n1" }, linker.LinkedNodes("h1"));

        // Same snapshot again: nothing changed.
        Assert.Empty(linker.OnHostSnapshot(host, HostSnapshot(("abc123def456789012", "web-api", "exited"))));
        Assert.Equal("exited", linker.LinkOf("n1")!.Container.State);

        // The container is gone from the host: the link is gone and the node is reported as changed.
        changed = linker.OnHostSnapshot(host, HostSnapshot(("fff", "web-db", "running")));
        Assert.Equal(["n1"], changed.Select(s => s.ServerId));
        Assert.Null(linker.LinkOf("n1"));
        Assert.Null(linker.LinkedNodes("h1"));
        Assert.Equal("acme-backend", node.Name);
        Assert.Equal("other", foreign.Name);
    }

    [Fact]
    public void Projections_carry_the_link_both_ways()
    {
        var registry = new AgentRegistry();
        var linker = new NodeLinker(registry);
        var host = Host(registry, "h1", "web-02", "owner-a");
        var node = Node(registry, "n1", "acme-backend", "owner-a", "abc123def456");
        var snapshot = HostSnapshot(("abc123def456789012", "web-api", "running"));
        host.StoreSnapshot(snapshot, Now);
        linker.OnHostSnapshot(host, snapshot);
        node.StoreSnapshot(AlertEngineHarness.NodeSnapshot(healthOk: false, status: 503), Now);

        var card = Projections.Card(node, null, Now, null, linker);
        Assert.Equal(NodeKinds.Container, card.Kind);
        Assert.Equal("web-02", card.OnHost);
        Assert.Equal(HealthStates.Fail, card.Health);
        Assert.Equal("ghcr.io/acme/app:1.0", card.Image);
        Assert.Equal(1, card.Restarts24h);
        Assert.NotNull(card.Ports);

        var server = Projections.Server(node, linker, Now);
        Assert.Equal("h1", server.HostServer!.ServerId);
        Assert.Equal("web-api", server.HostContainer!.Name);
        Assert.NotNull(server.Health);
        Assert.NotNull(server.Checks);
        Assert.Equal(1, server.Restarts10m);
        Assert.Null(server.Services);

        var hostView = Projections.Server(host, linker, Now);
        Assert.Equal("n1", hostView.LinkedNodes!["abc123def456789012"]);
        Assert.Equal(NodeKinds.Server, hostView.Kind);
        Assert.Null(hostView.HostServer);

        var serverCard = Projections.Card(host, null, Now, null, linker);
        Assert.Equal(NodeKinds.Server, serverCard.Kind);
        Assert.Null(serverCard.Health);
        Assert.Null(serverCard.OnHost);
    }

    [Fact]
    public async Task Stdout_of_a_linked_node_is_opened_on_the_host_with_the_container_id()
    {
        var registry = new AgentRegistry();
        var linker = new NodeLinker(registry);
        var receiver = new RecordingReceiver();
        var relay = new LogRelay(registry, receiver, linker, NullLogger<LogRelay>.Instance);
        var hostLink = new RecordingLink("link-h1");
        var host = Host(registry, "h1", "web-02", "owner-a", hostLink);
        Node(registry, "n1", "acme-backend", "owner-a", "abc123def456");

        // Not linked yet: unavailable with the dictionary text.
        var streamId = await relay.StartAsync("conn-1", new LogRequest("n1", "container"), CancellationToken.None);
        var ended = Assert.Single(receiver.Ended);
        Assert.Equal((streamId, LogEndReasons.Unavailable, LogRelay.NeedsHostAgent), (ended.StreamId, ended.Reason, ended.Message));

        linker.OnHostSnapshot(host, HostSnapshot(("abc123def456789012", "web-api", "running")));
        receiver.Ended.Clear();
        streamId = await relay.StartAsync("conn-1", new LogRequest("n1", "container", Tail: 50), CancellationToken.None);
        Assert.Empty(receiver.Ended);
        var start = Assert.IsType<LogStart>(Assert.Single(hostLink.Sent));
        Assert.Equal(streamId, start.StreamId);
        Assert.Equal("abc123def456789012", start.Container);
        Assert.Equal("container", start.Source);
        Assert.Equal(1, relay.CountByServer()["h1"]);

        // Lines come back from the host and reach the browser connection.
        await relay.OnLogEndAsync("h1", new LogEnd(streamId, LogEndReasons.Eof, null), CancellationToken.None);
        Assert.Equal((streamId, LogEndReasons.Eof), (receiver.Ended.Single().StreamId, receiver.Ended.Single().Reason));

        // A file log goes to the node itself with the path.
        var nodeLink = (RecordingLink)registry.All.Single(s => s.ServerId == "n1").Link!;
        await relay.StartAsync("conn-1", new LogRequest("n1", "file", Path: "/var/log/app/app.log"), CancellationToken.None);
        var fileStart = Assert.IsType<LogStart>(Assert.Single(nodeLink.Sent));
        Assert.Equal("/var/log/app/app.log", fileStart.Path);
    }

    [Fact]
    public void Forget_drops_links_of_a_removed_host_or_node()
    {
        var registry = new AgentRegistry();
        var linker = new NodeLinker(registry);
        var host = Host(registry, "h1", "web-02", "owner-a");
        Node(registry, "n1", "acme-backend", "owner-a", "abc123def456");
        linker.OnHostSnapshot(host, HostSnapshot(("abc123def456789012", "web-api", "running")));

        linker.Forget("h1");
        Assert.Null(linker.LinkOf("n1"));
        Assert.Null(linker.LinkedNodes("h1"));

        linker.OnHostSnapshot(host, HostSnapshot(("abc123def456789012", "web-api", "running")));
        linker.Forget("n1");
        Assert.Null(linker.LinkOf("n1"));
    }

    [Fact]
    public void Session_round_trips_kind_and_capabilities_through_the_document()
    {
        var session = new AgentSession("n1");
        session.Attach(new RecordingLink("l"), AlertEngineHarness.ContainerHello("acme-backend", "abc123def456"), Now);
        var doc = session.ToDocument();
        Assert.Equal(NodeKinds.Container, doc.Kind);
        Assert.Equal("abc123def456", doc.ContainerId);
        Assert.True(doc.Capabilities!.Cgroup);
        Assert.Equal("ghcr.io/acme/app:1.0", doc.Image);

        var restored = new AgentSession("n1");
        restored.Restore(doc);
        Assert.True(restored.IsContainer);
        Assert.Equal("abc123def456", restored.ContainerId);
        Assert.True(restored.Capabilities!.Health);
        Assert.Equal(JsonSerializer.Serialize(session.Capabilities), JsonSerializer.Serialize(restored.Capabilities));

        // A server document from before fase 12 has no kind: server.
        var old = new AgentSession("s1");
        old.Restore(new Glimt.Hub.Features.Servers.ServerDocument { Id = "s1", Name = "web-01", Hostname = "web-01" });
        Assert.False(old.IsContainer);
        Assert.Equal(NodeKinds.Server, old.Kind);
    }
}
