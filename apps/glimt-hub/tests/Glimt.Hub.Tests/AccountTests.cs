using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Glimt.Hub.Features.Access;
using Glimt.Hub.Features.Account;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;
using MongoDB.Bson;
using MongoDB.Driver;

namespace Glimt.Hub.Tests;

public sealed class AccountTests(TestHub hub) : IClassFixture<TestHub>
{
    [Fact]
    public async Task Patch_updates_name_timezone_and_language()
    {
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);

        var patched = await user.Client.PatchAsJsonAsync("/api/account", new { name = "Kari", timezone = "America/New_York", language = "NO" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, patched.StatusCode);
        var body = await patched.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("Kari", body.GetProperty("name").GetString());
        Assert.Equal("America/New_York", body.GetProperty("timezone").GetString());
        Assert.Equal("no", body.GetProperty("language").GetString());

        var account = await user.Client.GetFromJsonAsync<JsonElement>("/api/account", Repo.Timeout());
        Assert.Equal("Kari", account.GetProperty("name").GetString());
        Assert.False(account.GetProperty("ownsServers").GetBoolean());

        var bad = await user.Client.PatchAsJsonAsync("/api/account", new { timezone = "Mars/Olympus", language = "de" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var errors = (await bad.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout())).GetProperty("errors");
        Assert.True(errors.TryGetProperty("timezone", out _));
        Assert.True(errors.TryGetProperty("language", out _));
    }

    [Theory]
    [InlineData(0, false, 0, 0, 0)]
    [InlineData(2, false, 0, 0, 0)]
    [InlineData(3, false, 1, 12, 12)]
    [InlineData(3, true, 1, 12, 6)]
    [InlineData(16, false, 14, 168, 168)]
    [InlineData(16, true, 14, 168, 84)]
    public void Subscription_math(int used, bool earlyAdopter, int beta, int cost, int discounted)
    {
        var dto = Subscription.Compute(used, earlyAdopter, "beta");
        Assert.Equal(used, dto.SlotsUsed);
        Assert.Equal(2, dto.SlotsFree);
        Assert.Equal(beta, dto.SlotsBeta);
        Assert.Equal("beta", dto.Plan);
        Assert.Equal(12, dto.PlannedPricePerSlotUsd);
        Assert.Equal(earlyAdopter ? 50 : 0, dto.DiscountPct);
        Assert.Equal(cost, dto.WouldCostUsd);
        Assert.Equal(discounted, dto.WouldCostWithDiscountUsd);
        Assert.Equal(60, dto.NoticeDays);
    }

    [Fact]
    public async Task Subscription_counts_owned_servers()
    {
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);
        for (var i = 0; i < 3; i++)
        {
            await hub.AddServerAsync(user.Id, $"sub-{i}");
        }

        var dto = await user.Client.GetFromJsonAsync<SubscriptionDto>("/api/subscription", Repo.Timeout());
        Assert.NotNull(dto);
        Assert.Equal(3, dto.SlotsUsed);
        Assert.Equal(1, dto.SlotsBeta);
        Assert.Equal(12, dto.WouldCostUsd);
    }

    [Fact]
    public async Task Export_contains_every_section_and_no_secrets()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var reader = await TestUsers.RegisterAndConfirmAsync(hub);
        var server = await hub.AddServerAsync(owner.Id, "export-srv", ["prod"]);
        Assert.Equal(HttpStatusCode.Created, (await owner.Client.PostAsJsonAsync("/api/access", new { email = reader.Email, scope = "all" }, Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await reader.Client.PostAsJsonAsync("/api/access", new { email = owner.Email, scope = new[] { "prod" } }, Repo.Timeout())).StatusCode);
        await hub.Collection<BsonDocument>(AccountExport.PushSubscriptionsCollection).InsertOneAsync(new BsonDocument
        {
            ["userId"] = owner.Id,
            ["endpoint"] = "https://push.example/abc",
            ["p256dh"] = "secret-key",
            ["auth"] = "secret-auth",
            ["device"] = "Phone",
            ["createdAt"] = DateTime.UtcNow,
        });
        await hub.Collection<BsonDocument>(AccountExport.AlertSettingsCollection).InsertOneAsync(new BsonDocument
        {
            ["userId"] = owner.Id,
            ["rules"] = new BsonDocument("cpu", new BsonDocument { ["enabled"] = true, ["threshold"] = 95 }),
        });

        var response = await owner.Client.GetAsync("/api/account/export", Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
        Assert.Equal("glimtpanel-export.json", response.Content.Headers.ContentDisposition?.FileName?.Trim('"'));
        var text = await response.Content.ReadAsStringAsync(Repo.Timeout());
        Assert.DoesNotContain("passwordHash", text);
        Assert.DoesNotContain("tokenHash", text);
        Assert.DoesNotContain("secret-key", text);

        var json = JsonDocument.Parse(text).RootElement;
        Assert.Equal(owner.Email, json.GetProperty("user").GetProperty("email").GetString());
        Assert.Equal(server.Id, json.GetProperty("servers")[0].GetProperty("id").GetString());
        Assert.Equal("prod", json.GetProperty("servers")[0].GetProperty("tags")[0].GetString());
        Assert.Equal(reader.Email, json.GetProperty("accessGrants").GetProperty("given")[0].GetProperty("email").GetString());
        Assert.Equal("prod", json.GetProperty("accessGrants").GetProperty("received")[0].GetProperty("scope")[0].GetString());
        Assert.True(json.GetProperty("alertSettings").GetProperty("rules").GetProperty("cpu").GetProperty("enabled").GetBoolean());
        Assert.Equal(JsonValueKind.Array, json.GetProperty("alerts").ValueKind);
        Assert.Equal(0, json.GetProperty("alerts").GetArrayLength());
        Assert.Equal("https://push.example/abc", json.GetProperty("pushSubscriptions")[0].GetProperty("endpoint").GetString());
    }

    [Fact]
    public async Task Delete_account_cascades_and_notifies_the_agent_side()
    {
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var reader = await TestUsers.RegisterAndConfirmAsync(hub);
        var s1 = await hub.AddServerAsync(owner.Id, "del-1");
        var s2 = await hub.AddServerAsync(owner.Id, "del-2");
        Assert.Equal(HttpStatusCode.Created, (await owner.Client.PostAsJsonAsync("/api/access", new { email = reader.Email, scope = "all" }, Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await reader.Client.PostAsJsonAsync("/api/access", new { email = owner.Email, scope = "all" }, Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await owner.Client.PostAsJsonAsync("/api/servers/enrol-key", new { dockerMode = "none" }, Repo.Timeout())).StatusCode);

        var wrong = await owner.Client.SendAsync(new HttpRequestMessage(HttpMethod.Delete, "/api/account") { Content = JsonContent.Create(new { password = "wrong-password-here" }) }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);

        var delete = await owner.Client.SendAsync(new HttpRequestMessage(HttpMethod.Delete, "/api/account") { Content = JsonContent.Create(new { password = owner.Password }) }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        Assert.Contains(s1.Id, hub.Lifecycle.Removed);
        Assert.Contains(s2.Id, hub.Lifecycle.Removed);
        Assert.Null(await hub.Collection<UserDocument>(UserDocument.Collection).Find(u => u.Id == owner.Id).FirstOrDefaultAsync());
        Assert.Equal(0, await hub.Collection<ServerDocument>(ServerDocument.Collection).CountDocumentsAsync(s => s.OwnerId == owner.Id));
        Assert.Equal(0, await hub.Collection<AccessGrantDocument>(AccessGrantDocument.Collection).CountDocumentsAsync(g => g.OwnerId == owner.Id || g.UserId == owner.Id));
        Assert.Equal(0, await hub.Collection<RefreshTokenDocument>(RefreshTokenDocument.Collection).CountDocumentsAsync(t => t.UserId == owner.Id));
        Assert.Equal(0, await hub.Collection<EmailTokenDocument>(EmailTokenDocument.Collection).CountDocumentsAsync(t => t.UserId == owner.Id));
        Assert.Equal(0, await hub.Collection<EnrolKeyDocument>(EnrolKeyDocument.Collection).CountDocumentsAsync(k => k.OwnerId == owner.Id));

        // the token still parses, but the user is gone
        Assert.Equal(HttpStatusCode.Unauthorized, (await owner.Client.GetAsync("/api/auth/me", Repo.Timeout())).StatusCode);
        var readerMe = await reader.Client.GetFromJsonAsync<JsonElement>("/api/auth/me", Repo.Timeout());
        Assert.Equal(0, readerMe.GetProperty("readerOf").GetInt32());
    }
}
