using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Glimt.Hub.Features.Demo;
using Glimt.Hub.Features.Groups;
using Glimt.Hub.Features.Servers;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;

namespace Glimt.Hub.Tests;

/// <summary>/api/groups (IMPLEMENTERINGSPLAN step 13.1): CRUD, membership rules, limits, other people's groups, cascade from deleted nodes and accounts, export.</summary>
public sealed class GroupsTests(TestHub hub) : IClassFixture<TestHub>
{
    private static async Task<JsonElement> CreateAsync(TestUser owner, string name, params string[] members)
    {
        var response = await owner.Client.PostAsJsonAsync("/api/groups", new { name, memberIds = members }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
    }

    private static string[] Members(JsonElement group) => group.GetProperty("memberIds").EnumerateArray().Select(m => m.GetString()!).ToArray();

    [Fact]
    public async Task Crud_with_order_and_normalised_names()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        var a = await hub.AddServerAsync(owner.Id, "srv-a");
        var b = await hub.AddServerAsync(owner.Id, "srv-b");

        var created = await CreateAsync(owner, "  Acme   prod ", a.Id, b.Id, a.Id);
        Assert.Equal("Acme prod", created.GetProperty("name").GetString());
        Assert.Equal(new[] { a.Id, b.Id }, Members(created));
        Assert.Equal(0, created.GetProperty("order").GetInt32());
        var id = created.GetProperty("id").GetString()!;

        var second = await CreateAsync(owner, "Edge");
        Assert.Equal(1, second.GetProperty("order").GetInt32());
        Assert.Empty(Members(second));

        var list = await owner.Client.GetFromJsonAsync<JsonElement>("/api/groups", Repo.Timeout());
        Assert.Equal(new[] { "Acme prod", "Edge" }, list.EnumerateArray().Select(g => g.GetProperty("name").GetString()));

        var patched = await owner.Client.PatchAsJsonAsync($"/api/groups/{id}", new { name = "Acme", memberIds = new[] { b.Id }, order = 5 }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, patched.StatusCode);
        var dto = await patched.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("Acme", dto.GetProperty("name").GetString());
        Assert.Equal(new[] { b.Id }, Members(dto));
        Assert.Equal(5, dto.GetProperty("order").GetInt32());
        list = await owner.Client.GetFromJsonAsync<JsonElement>("/api/groups", Repo.Timeout());
        Assert.Equal(new[] { "Edge", "Acme" }, list.EnumerateArray().Select(g => g.GetProperty("name").GetString()));

        var bad = await owner.Client.PatchAsJsonAsync($"/api/groups/{id}", new { name = new string('x', 41) }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var empty = await owner.Client.PostAsJsonAsync("/api/groups", new { name = "   " }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, empty.StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await owner.Client.DeleteAsync($"/api/groups/{id}", Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Client.DeleteAsync($"/api/groups/{id}", Repo.Timeout())).StatusCode);
        list = await owner.Client.GetFromJsonAsync<JsonElement>("/api/groups", Repo.Timeout());
        Assert.Single(list.EnumerateArray());
    }

    [Fact]
    public async Task Members_need_read_access_and_lost_access_hides_them_without_changing_the_document()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var other = await TestUsers.RegisterAndConfirmAsync(hub);
        var mine = await hub.AddServerAsync(owner.Id, "mine");
        var theirs = await hub.AddServerAsync(other.Id, "theirs");

        var denied = await owner.Client.PostAsJsonAsync("/api/groups", new { name = "Mixed", memberIds = new[] { mine.Id, theirs.Id } }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, denied.StatusCode);
        Assert.Contains(theirs.Id, await denied.Content.ReadAsStringAsync(Repo.Timeout()));

        // A reader grant makes the other server a valid member …
        var grant = await other.Client.PostAsJsonAsync("/api/access", new { email = owner.Email, scope = "all" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Created, grant.StatusCode);
        var created = await CreateAsync(owner, "Mixed", mine.Id, theirs.Id);
        Assert.Equal(new[] { mine.Id, theirs.Id }, Members(created));

        // … and revoking it hides the member when read, while the document keeps it.
        var grantId = (await grant.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout())).GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.NoContent, (await other.Client.DeleteAsync($"/api/access/{grantId}", Repo.Timeout())).StatusCode);
        var list = await owner.Client.GetFromJsonAsync<JsonElement>("/api/groups", Repo.Timeout());
        Assert.Equal(new[] { mine.Id }, Members(list.EnumerateArray().Single()));
        var stored = await hub.Collection<GroupDocument>(GroupDocument.Collection).Find(g => g.Id == created.GetProperty("id").GetString()).FirstAsync();
        Assert.Equal(new[] { mine.Id, theirs.Id }, stored.MemberIds);
    }

    [Fact]
    public async Task Other_peoples_groups_give_403_and_a_deleted_node_leaves_every_group()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var stranger = await TestUsers.RegisterAndConfirmAsync(hub);
        var a = await hub.AddServerAsync(owner.Id, "gone-soon");
        var b = await hub.AddServerAsync(owner.Id, "stays");
        var g1 = await CreateAsync(owner, "One", a.Id, b.Id);
        var g2 = await CreateAsync(owner, "Two", a.Id);
        var id = g1.GetProperty("id").GetString()!;

        Assert.Equal(HttpStatusCode.Forbidden, (await stranger.Client.PatchAsJsonAsync($"/api/groups/{id}", new { name = "Mine now" }, Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await stranger.Client.DeleteAsync($"/api/groups/{id}", Repo.Timeout())).StatusCode);
        Assert.Empty((await stranger.Client.GetFromJsonAsync<JsonElement>("/api/groups", Repo.Timeout())).EnumerateArray());

        Assert.Equal(HttpStatusCode.OK, (await owner.Client.DeleteAsync($"/api/servers/{a.Id}", Repo.Timeout())).StatusCode);
        var list = (await owner.Client.GetFromJsonAsync<JsonElement>("/api/groups", Repo.Timeout())).EnumerateArray().ToDictionary(g => g.GetProperty("name").GetString()!, Members);
        Assert.Equal(new[] { b.Id }, list["One"]);
        Assert.Empty(list["Two"]);
        var stored = await hub.Collection<GroupDocument>(GroupDocument.Collection).Find(g => g.Id == g2.GetProperty("id").GetString()).FirstAsync();
        Assert.Empty(stored.MemberIds);
    }

    [Fact]
    public async Task Limits_fifty_groups_and_a_hundred_members()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        var store = hub.Services.GetRequiredService<GroupStore>();
        var now = DateTime.UtcNow;
        for (var i = 0; i < GroupDocument.MaxPerUser; i++)
        {
            await store.InsertAsync(new GroupDocument { OwnerId = owner.Id, Name = $"g{i}", Order = i, CreatedAt = now, UpdatedAt = now }, Repo.Timeout());
        }

        var tooMany = await owner.Client.PostAsJsonAsync("/api/groups", new { name = "one more" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, tooMany.StatusCode);

        var ids = Enumerable.Range(0, GroupDocument.MaxMembers + 1).Select(i => $"fake-{i}").ToArray();
        var tooManyMembers = await owner.Client.PatchAsJsonAsync($"/api/groups/{(await store.ListByOwnerAsync(owner.Id, Repo.Timeout()))[0].Id}", new { memberIds = ids }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, tooManyMembers.StatusCode);
        Assert.Contains("At most 100", await tooManyMembers.Content.ReadAsStringAsync(Repo.Timeout()));
    }

    [Fact]
    public async Task Export_includes_groups_and_the_demo_account_is_read_only()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        var a = await hub.AddServerAsync(owner.Id, "exported");
        await CreateAsync(owner, "Exported group", a.Id);
        var export = await owner.Client.GetFromJsonAsync<JsonElement>("/api/account/export", Repo.Timeout());
        var group = export.GetProperty("groups").EnumerateArray().Single();
        Assert.Equal("Exported group", group.GetProperty("name").GetString());
        Assert.Equal(new[] { a.Id }, Members(group));

        // The demo account (seeded with two groups by the demo mode) can list but not write.
        var demo = hub.Services.GetRequiredService<FakeAgentService>();
        await demo.Ready.WaitAsync(TimeSpan.FromSeconds(20), Repo.Timeout());
        var session = await hub.CreateClient().PostAsync("/api/demo/session", null, Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, session.StatusCode);
        var token = (await session.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout())).GetProperty("accessToken").GetString()!;
        using var client = LiveTestSupport.Bearer(hub.App, token);
        var forbidden = await client.PostAsJsonAsync("/api/groups", new { name = "Nope" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);

        // The seeded groups belong to the owner of the demo servers (the dev user in e2e).
        var stored = await hub.Collection<GroupDocument>(GroupDocument.Collection).Find(g => g.Id == "demo-acme").FirstOrDefaultAsync();
        Assert.NotNull(stored);
        Assert.Equal("Acme", stored.Name);
        Assert.Equal(demo.OwnerId, stored.OwnerId);
        Assert.Contains("demo-acme-backend", stored.MemberIds);

        // /demo (step 10.1): the demo account reads the 16 servers and 3 nodes as a reader and has its own copy of the two groups.
        var visible = await client.GetFromJsonAsync<JsonElement>("/api/servers", Repo.Timeout());
        var demoNodes = visible.EnumerateArray().Where(s => s.GetProperty("id").GetString()!.StartsWith(DemoData.ServerIdPrefix, StringComparison.Ordinal)).ToList();
        Assert.Equal(DemoData.Definitions.Length + DemoData.Nodes.Length, demoNodes.Count);
        Assert.All(demoNodes, s => Assert.Equal(ServerRoles.Reader, s.GetProperty("role").GetString()));
        var demoGroups = await client.GetFromJsonAsync<JsonElement>("/api/groups", Repo.Timeout());
        Assert.Equal(["Acme", "Edge"], demoGroups.EnumerateArray().Select(g => g.GetProperty("name").GetString()!).ToArray());
        Assert.All(demoGroups.EnumerateArray(), g => Assert.EndsWith(DemoData.GroupIdSuffixDemo, g.GetProperty("id").GetString()));
    }
}
