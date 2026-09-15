using Glimt.Hub.Features.Auth;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Auth;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;

namespace Glimt.Hub.Tests;

public sealed class ServersTests(TestHub hub) : IClassFixture<TestHub>
{
    [Fact]
    public async Task Enrol_key_is_created_and_consumed_once()
    {
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);

        var bad = await user.Client.PostAsJsonAsync("/api/servers/enrol-key", new { dockerMode = "podman" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);

        var response = await user.Client.PostAsJsonAsync("/api/servers/enrol-key", new { dockerMode = "simple" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        var key = body.GetProperty("key").GetString()!;
        Assert.StartsWith("gp_", key);
        Assert.Equal(25, key.Length);
        Assert.Matches("^gp_[0-9A-Za-z]{22}$", key);
        Assert.Equal("simple", body.GetProperty("dockerMode").GetString());
        Assert.Equal($"curl -fsSL http://localhost:5080/install | sh -s -- --key {key} --docker simple", body.GetProperty("command").GetString());
        var expires = body.GetProperty("expiresAt").GetDateTimeOffset();
        Assert.InRange(expires, DateTimeOffset.UtcNow.AddMinutes(58), DateTimeOffset.UtcNow.AddMinutes(62));

        var store = hub.Services.GetRequiredService<IEnrolKeyStore>();
        Assert.IsType<MongoEnrolKeyStore>(store);
        Assert.Null(await store.TryConsumeAsync("gp_not-a-real-key-at-all0", Repo.Timeout()));
        var info = await store.TryConsumeAsync(key, Repo.Timeout());
        Assert.NotNull(info);
        Assert.Equal(user.Id, info.OwnerId);
        Assert.Equal("simple", info.DockerMode);
        Assert.Null(await store.TryConsumeAsync(key, Repo.Timeout()));

        var stored = await hub.Collection<EnrolKeyDocument>(EnrolKeyDocument.Collection).Find(k => k.KeyHash == Tokens.Hash(key)).FirstAsync();
        Assert.NotNull(stored.UsedAt);
    }

    [Fact]
    public async Task Expired_enrol_key_cannot_be_consumed()
    {
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);
        var key = MongoEnrolKeyStore.GenerateKey();
        await hub.Collection<EnrolKeyDocument>(EnrolKeyDocument.Collection).InsertOneAsync(new EnrolKeyDocument
        {
            KeyHash = Tokens.Hash(key),
            OwnerId = user.Id,
            DockerMode = "proxy",
            ExpiresAt = DateTime.UtcNow.AddMinutes(-1),
            CreatedAt = DateTime.UtcNow.AddHours(-1),
        });

        Assert.Null(await hub.Services.GetRequiredService<IEnrolKeyStore>().TryConsumeAsync(key, Repo.Timeout()));
    }

    [Fact]
    public async Task Enrol_key_requires_a_confirmed_email()
    {
        var email = TestUsers.NewEmail("unconf");
        using var client = hub.CreateClient();
        var register = await client.PostAsJsonAsync("/api/auth/register", new { email, password = TestUsers.DefaultPassword, name = "Pending" }, Repo.Timeout());
        var id = (await register.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout())).GetProperty("id").GetString()!;

        // no login is possible before confirmation, so mint the access token directly
        var token = hub.Services.GetRequiredService<JwtTokens>().IssueAccessToken(id, email, "Pending", "en");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await client.PostAsJsonAsync("/api/servers/enrol-key", new { dockerMode = "proxy" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("emailNotConfirmed", (await response.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout())).GetProperty("code").GetString());
    }

    [Fact]
    public async Task List_and_get_respect_owner_reader_and_stranger()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var reader = await TestUsers.RegisterAndConfirmAsync(hub);
        using var stranger = await TestUsers.RegisterAndConfirmAsync(hub);
        var old = await hub.AddServerAsync(owner.Id, "focal", ["web"], ubuntuVersion: "20.04");
        var current = await hub.AddServerAsync(owner.Id, "noble", ["db"], ubuntuVersion: "24.04");
        var debian = await hub.AddServerAsync(owner.Id, "bookworm", ubuntuVersion: null);
        Assert.Equal(HttpStatusCode.Created, (await owner.Client.PostAsJsonAsync("/api/access", new { email = reader.Email, scope = "all" }, Repo.Timeout())).StatusCode);

        var ownerList = await owner.Client.GetFromJsonAsync<JsonElement>("/api/servers", Repo.Timeout());
        var byId = ownerList.EnumerateArray().ToDictionary(s => s.GetProperty("id").GetString()!);
        Assert.Equal(3, byId.Count);
        Assert.All(byId.Values, s => Assert.Equal("owner", s.GetProperty("role").GetString()));
        Assert.All(byId.Values, s => Assert.Equal(JsonValueKind.Null, s.GetProperty("ownerEmail").ValueKind));
        Assert.Equal("2025-05-31", byId[old.Id].GetProperty("supportUntil").GetString());
        Assert.True(byId[old.Id].GetProperty("eol").GetBoolean());
        Assert.Equal("2029-04-30", byId[current.Id].GetProperty("supportUntil").GetString());
        Assert.False(byId[current.Id].GetProperty("eol").GetBoolean());
        Assert.Equal(JsonValueKind.Null, byId[debian.Id].GetProperty("supportUntil").ValueKind);
        Assert.False(byId[debian.Id].GetProperty("eol").GetBoolean());
        Assert.Equal("web", byId[old.Id].GetProperty("tags")[0].GetString());
        Assert.Equal("down", byId[old.Id].GetProperty("status").GetString());
        Assert.Equal("ubuntu", byId[old.Id].GetProperty("os").GetProperty("id").GetString());

        var readerList = await reader.Client.GetFromJsonAsync<JsonElement>("/api/servers", Repo.Timeout());
        Assert.Equal(3, readerList.GetArrayLength());
        Assert.All(readerList.EnumerateArray(), s => Assert.Equal("reader", s.GetProperty("role").GetString()));
        Assert.All(readerList.EnumerateArray(), s => Assert.Equal(owner.Email, s.GetProperty("ownerEmail").GetString()));

        var strangerList = await stranger.Client.GetFromJsonAsync<JsonElement>("/api/servers", Repo.Timeout());
        Assert.Equal(0, strangerList.GetArrayLength());

        var one = await reader.Client.GetFromJsonAsync<JsonElement>($"/api/servers/{current.Id}", Repo.Timeout());
        Assert.Equal("noble", one.GetProperty("name").GetString());
        Assert.Equal("reader", one.GetProperty("role").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await stranger.Client.GetAsync($"/api/servers/{current.Id}", Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Client.GetAsync("/api/servers/does-not-exist", Repo.Timeout())).StatusCode);

        var me = await owner.Client.GetFromJsonAsync<JsonElement>("/api/auth/me", Repo.Timeout());
        Assert.True(me.GetProperty("ownsServers").GetBoolean());
    }

    [Fact]
    public async Task Patch_validates_name_and_tags_and_requires_owner()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var reader = await TestUsers.RegisterAndConfirmAsync(hub);
        var server = await hub.AddServerAsync(owner.Id, "patch-me");
        Assert.Equal(HttpStatusCode.Created, (await owner.Client.PostAsJsonAsync("/api/access", new { email = reader.Email, scope = "all" }, Repo.Timeout())).StatusCode);

        var ok = await owner.Client.PatchAsJsonAsync($"/api/servers/{server.Id}", new { name = "  Web 01 ", tags = new[] { "Prod", "prod", "web-1" } }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var body = await ok.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("Web 01", body.GetProperty("name").GetString());
        Assert.Equal(new[] { "prod", "web-1" }, body.GetProperty("tags").EnumerateArray().Select(t => t.GetString()).ToArray());

        var badTag = await owner.Client.PatchAsJsonAsync($"/api/servers/{server.Id}", new { tags = new[] { "has space" } }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, badTag.StatusCode);
        var tooMany = await owner.Client.PatchAsJsonAsync($"/api/servers/{server.Id}", new { tags = Enumerable.Range(0, 11).Select(i => $"t{i}").ToArray() }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, tooMany.StatusCode);
        var badName = await owner.Client.PatchAsJsonAsync($"/api/servers/{server.Id}", new { name = new string('x', 65) }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, badName.StatusCode);

        var forbidden = await reader.Client.PatchAsJsonAsync($"/api/servers/{server.Id}", new { name = "hijack" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
    }

    [Fact]
    public async Task Delete_removes_the_server_and_notifies_the_agent_side()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var reader = await TestUsers.RegisterAndConfirmAsync(hub);
        var server = await hub.AddServerAsync(owner.Id, "delete-me");
        Assert.Equal(HttpStatusCode.Created, (await owner.Client.PostAsJsonAsync("/api/access", new { email = reader.Email, scope = "all" }, Repo.Timeout())).StatusCode);

        Assert.Equal(HttpStatusCode.Forbidden, (await reader.Client.DeleteAsync($"/api/servers/{server.Id}", Repo.Timeout())).StatusCode);

        var response = await owner.Client.DeleteAsync($"/api/servers/{server.Id}", Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("sudo /usr/local/bin/glimt-agent uninstall", body.GetProperty("uninstallCommand").GetString());
        Assert.Contains(server.Id, hub.Lifecycle.Removed);
        Assert.Null(await hub.Collection<ServerDocument>(ServerDocument.Collection).Find(s => s.Id == server.Id).FirstOrDefaultAsync());
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Client.DeleteAsync($"/api/servers/{server.Id}", Repo.Timeout())).StatusCode);
    }

    [Fact]
    public async Task Rotate_key_stores_the_new_hash_keeps_the_old_for_ten_minutes_and_never_returns_the_token()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var reader = await TestUsers.RegisterAndConfirmAsync(hub);
        var server = await hub.AddServerAsync(owner.Id, "rotate-me");
        Assert.Equal(HttpStatusCode.Created, (await owner.Client.PostAsJsonAsync("/api/access", new { email = reader.Email, scope = "all" }, Repo.Timeout())).StatusCode);

        Assert.Equal(HttpStatusCode.Forbidden, (await reader.Client.PostAsync($"/api/servers/{server.Id}/rotate-key", null, Repo.Timeout())).StatusCode);

        var response = await owner.Client.PostAsync($"/api/servers/{server.Id}/rotate-key", null, Repo.Timeout());
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(0L, response.Content.Headers.ContentLength ?? 0L);

        var rotated = Assert.Single(hub.Lifecycle.Rotated, r => r.ServerId == server.Id);
        Assert.StartsWith("agt_", rotated.Token);
        Assert.Equal(Tokens.Hash(rotated.Token), rotated.TokenHash);

        var doc = await hub.Collection<ServerDocument>(ServerDocument.Collection).Find(s => s.Id == server.Id).FirstAsync();
        Assert.Equal(rotated.TokenHash, doc.TokenHash);
        Assert.Equal(server.TokenHash, doc.PreviousTokenHash);
        Assert.NotNull(doc.PreviousTokenValidUntil);
        Assert.InRange(doc.PreviousTokenValidUntil.Value, DateTime.UtcNow.AddMinutes(9), DateTime.UtcNow.AddMinutes(11));
    }

    [Theory]
    [InlineData("ubuntu", "20.04", "2025-05-31", true)]
    [InlineData("ubuntu", "22.04", "2027-04-30", false)]
    [InlineData("ubuntu", "24.04", "2029-04-30", false)]
    [InlineData("ubuntu", "26.04", "2031-04-30", false)]
    [InlineData("ubuntu", "18.04", null, false)]
    [InlineData("debian", "12", null, false)]
    public void Ubuntu_support_table(string osId, string version, string? supportUntil, bool eolToday)
    {
        var today = new DateOnly(2026, 9, 10);
        var until = UbuntuSupport.SupportUntil(osId, version);
        Assert.Equal(supportUntil is null ? null : DateOnly.Parse(supportUntil), until);
        Assert.Equal(eolToday, UbuntuSupport.IsEol(until, today));
        if (until is { } date)
        {
            Assert.False(UbuntuSupport.IsEol(until, date));
            Assert.True(UbuntuSupport.IsEol(until, date.AddDays(1)));
        }
    }
}
