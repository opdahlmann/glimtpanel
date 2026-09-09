using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Glimt.Hub.Features.Access;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Infrastructure.Access;
using Glimt.Hub.Infrastructure.Email;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;

namespace Glimt.Hub.Tests;

public sealed class AccessTests(TestHub hub) : IClassFixture<TestHub>
{
    private IAccessService Access => hub.Services.GetRequiredService<IAccessService>();

    [Fact]
    public async Task Inviting_an_existing_user_grants_access_immediately()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub, name: "Ola Nordmann");
        using var reader = await TestUsers.RegisterAndConfirmAsync(hub, name: "Kari Hansen");
        var server = await hub.AddServerAsync(owner.Id, "shared");

        var response = await owner.Client.PostAsJsonAsync("/api/access", new { email = reader.Email.ToUpperInvariant(), scope = "all" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var grant = await response.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("accepted", grant.GetProperty("status").GetString());
        Assert.Equal("all", grant.GetProperty("scope").GetString());
        Assert.Equal(reader.Email, grant.GetProperty("email").GetString());
        Assert.Equal("KH", grant.GetProperty("initials").GetString());

        var mail = hub.Mails.Last(reader.Email);
        Assert.Contains("Ola Nordmann", mail.Subject);
        Assert.Contains("read access", mail.Text);

        var list = await owner.Client.GetFromJsonAsync<JsonElement>("/api/access", Repo.Timeout());
        Assert.Single(list.EnumerateArray());
        Assert.Equal(grant.GetProperty("id").GetString(), list[0].GetProperty("id").GetString());

        Assert.Equal(new[] { server.Id }, await Access.VisibleServerIdsAsync(reader.Id, Repo.Timeout()));
        Assert.True(await Access.CanReadAsync(reader.Id, server.Id, Repo.Timeout()));
        Assert.False(await Access.IsOwnerAsync(reader.Id, server.Id, Repo.Timeout()));
        Assert.True(await Access.IsOwnerAsync(owner.Id, server.Id, Repo.Timeout()));
        var readerMe = await reader.Client.GetFromJsonAsync<JsonElement>("/api/auth/me", Repo.Timeout());
        Assert.Equal(1, readerMe.GetProperty("readerOf").GetInt32());

        var duplicate = await owner.Client.PostAsJsonAsync("/api/access", new { email = reader.Email, scope = "all" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);

        var deleted = await owner.Client.DeleteAsync($"/api/access/{grant.GetProperty("id").GetString()}", Repo.Timeout());
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        Assert.Empty(await Access.VisibleServerIdsAsync(reader.Id, Repo.Timeout()));
        Assert.False(await Access.CanReadAsync(reader.Id, server.Id, Repo.Timeout()));
    }

    [Fact]
    public async Task Inviting_an_unknown_email_is_pending_until_they_register()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        var server = await hub.AddServerAsync(owner.Id, "pending-srv");
        var invited = $"invited.person.{Guid.NewGuid():N}@test.local";

        var response = await owner.Client.PostAsJsonAsync("/api/access", new { email = invited, scope = new[] { "Prod" } }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var grant = await response.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("pending", grant.GetProperty("status").GetString());
        Assert.Equal("prod", grant.GetProperty("scope")[0].GetString());
        Assert.Equal("IP", grant.GetProperty("initials").GetString());
        Assert.Contains("http://localhost:4200/access/accept?token=", hub.Mails.Last(invited).Text);

        // registering with the invited address links the grant (the register hook)
        using var reader = await TestUsers.RegisterAndConfirmAsync(hub, email: invited);
        var list = await owner.Client.GetFromJsonAsync<JsonElement>("/api/access", Repo.Timeout());
        Assert.Equal("accepted", list[0].GetProperty("status").GetString());
        var stored = await hub.Collection<AccessGrantDocument>(AccessGrantDocument.Collection).Find(g => g.Id == grant.GetProperty("id").GetString()).FirstAsync();
        Assert.Equal(reader.Id, stored.UserId);
        Assert.Null(stored.InviteTokenHash);

        // scope is tags: the untagged server is not visible until it gets the tag
        Assert.Empty(await Access.VisibleServerIdsAsync(reader.Id, Repo.Timeout()));
        await owner.Client.PatchAsJsonAsync($"/api/servers/{server.Id}", new { tags = new[] { "prod" } }, Repo.Timeout());
        Assert.Equal(new[] { server.Id }, await Access.VisibleServerIdsAsync(reader.Id, Repo.Timeout()));
    }

    [Fact]
    public async Task Accept_links_a_pending_grant_to_the_matching_user_only()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub, name: "Owner Person");
        using var reader = await TestUsers.RegisterAndConfirmAsync(hub);
        using var other = await TestUsers.RegisterAndConfirmAsync(hub);
        var server = await hub.AddServerAsync(owner.Id, "accept-srv", ["prod"]);

        // a grant created before the reader existed (inserted directly so the register hook does not link it)
        var token = Tokens.Generate();
        var grant = new AccessGrantDocument
        {
            OwnerId = owner.Id,
            Email = reader.Email,
            Scope = GrantScopes.Tags,
            Tags = ["prod"],
            Status = GrantStatuses.Pending,
            InviteTokenHash = Tokens.Hash(token),
            CreatedAt = DateTime.UtcNow,
        };
        await hub.Collection<AccessGrantDocument>(AccessGrantDocument.Collection).InsertOneAsync(grant);
        Assert.Empty(await Access.VisibleServerIdsAsync(reader.Id, Repo.Timeout()));

        var wrongUser = await other.Client.PostAsJsonAsync("/api/access/accept", new { token }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Forbidden, wrongUser.StatusCode);
        var badToken = await reader.Client.PostAsJsonAsync("/api/access/accept", new { token = "nope" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, badToken.StatusCode);

        var accepted = await reader.Client.PostAsJsonAsync("/api/access/accept", new { token }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        var body = await accepted.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("accepted", body.GetProperty("status").GetString());
        Assert.Equal(owner.Email, body.GetProperty("ownerEmail").GetString());
        Assert.Equal("Owner Person", body.GetProperty("ownerName").GetString());
        Assert.Equal("prod", body.GetProperty("scope")[0].GetString());

        Assert.Equal(new[] { server.Id }, await Access.VisibleServerIdsAsync(reader.Id, Repo.Timeout()));
        var again = await reader.Client.PostAsJsonAsync("/api/access/accept", new { token }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
    }

    [Fact]
    public async Task Tag_scope_limits_visibility_and_fan_out()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var prodReader = await TestUsers.RegisterAndConfirmAsync(hub);
        using var allReader = await TestUsers.RegisterAndConfirmAsync(hub);
        var prod = await hub.AddServerAsync(owner.Id, "prod-1", ["prod", "web"]);
        var dev = await hub.AddServerAsync(owner.Id, "dev-1", ["dev"]);
        var untagged = await hub.AddServerAsync(owner.Id, "bare");
        var foreign = await hub.AddServerAsync(prodReader.Id, "mine", ["prod"]);

        Assert.Equal(HttpStatusCode.Created, (await owner.Client.PostAsJsonAsync("/api/access", new { email = prodReader.Email, scope = new[] { "prod", "staging" } }, Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await owner.Client.PostAsJsonAsync("/api/access", new { email = allReader.Email, scope = "all" }, Repo.Timeout())).StatusCode);

        var prodVisible = await Access.VisibleServerIdsAsync(prodReader.Id, Repo.Timeout());
        Assert.Equal(new[] { foreign.Id, prod.Id }.Order(), prodVisible.Order());
        Assert.True(await Access.CanReadAsync(prodReader.Id, prod.Id, Repo.Timeout()));
        Assert.False(await Access.CanReadAsync(prodReader.Id, dev.Id, Repo.Timeout()));
        Assert.False(await Access.CanReadAsync(prodReader.Id, untagged.Id, Repo.Timeout()));
        Assert.False(await Access.CanReadAsync(prodReader.Id, "missing", Repo.Timeout()));

        var allVisible = await Access.VisibleServerIdsAsync(allReader.Id, Repo.Timeout());
        Assert.Equal(new[] { prod.Id, dev.Id, untagged.Id }.Order(), allVisible.Order());

        Assert.Equal(new[] { owner.Id, prodReader.Id, allReader.Id }.Order(), (await Access.UserIdsWithAccessAsync(prod.Id, Repo.Timeout())).Order());
        Assert.Equal(new[] { owner.Id, allReader.Id }.Order(), (await Access.UserIdsWithAccessAsync(dev.Id, Repo.Timeout())).Order());
        Assert.Equal(new[] { prodReader.Id }, await Access.UserIdsWithAccessAsync(foreign.Id, Repo.Timeout()));
        Assert.Empty(await Access.UserIdsWithAccessAsync("missing", Repo.Timeout()));

        var list = await prodReader.Client.GetFromJsonAsync<JsonElement>("/api/servers", Repo.Timeout());
        var roles = list.EnumerateArray().ToDictionary(s => s.GetProperty("id").GetString()!, s => s.GetProperty("role").GetString());
        Assert.Equal("owner", roles[foreign.Id]);
        Assert.Equal("reader", roles[prod.Id]);
    }

    [Fact]
    public async Task Create_validates_email_scope_and_self_invite()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);

        var self = await owner.Client.PostAsJsonAsync("/api/access", new { email = owner.Email, scope = "all" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, self.StatusCode);

        var bad = await owner.Client.PostAsJsonAsync("/api/access", new { email = "nope", scope = "some" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var errors = (await bad.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout())).GetProperty("errors");
        Assert.True(errors.TryGetProperty("email", out _));
        Assert.True(errors.TryGetProperty("scope", out _));

        var emptyTags = await owner.Client.PostAsJsonAsync("/api/access", new { email = TestUsers.NewEmail(), scope = Array.Empty<string>() }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, emptyTags.StatusCode);
        var badTag = await owner.Client.PostAsJsonAsync("/api/access", new { email = TestUsers.NewEmail(), scope = new[] { "Not Valid!" } }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, badTag.StatusCode);

        Assert.Equal(HttpStatusCode.NotFound, (await owner.Client.DeleteAsync("/api/access/does-not-exist", Repo.Timeout())).StatusCode);
    }

    [Fact]
    public void Email_templates_follow_the_language()
    {
        var no = EmailTemplates.Confirm("a@b.no", "no", "http://x/confirm?token=t");
        Assert.Contains("Bekreft", no.Subject);
        Assert.Contains("http://x/confirm?token=t", no.Text);
        Assert.Contains("href=\"http://x/confirm?token=t\"", no.Html);

        var en = EmailTemplates.Reset("a@b.no", "de", "http://x/reset?token=t");
        Assert.Contains("Reset", en.Subject);
        Assert.Contains("1 hour", en.Text);

        var invite = EmailTemplates.Invite("a@b.no", null, "Ola <b>", "http://x/access/accept?token=t");
        Assert.Contains("Ola <b>", invite.Subject);
        Assert.Contains("Ola &lt;b&gt;", invite.Html);
    }
}
