using Glimt.Hub.Infrastructure;
using Glimt.Hub.Features.Servers;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Glimt.Hub.Tests;

public sealed class HealthTests(HubFactory factory) : IClassFixture<HubFactory>
{
    [Fact]
    public async Task Healthz_is_ok_without_mongo()
    {
        using var client = factory.CreateClient();
        var response = await client.GetAsync("/healthz", Repo.Timeout());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("ok", body.GetProperty("status").GetString());
        Assert.Equal("unavailable", body.GetProperty("mongo").GetString());
        Assert.Equal("e2e", body.GetProperty("env").GetString());
        Assert.Equal(0, body.GetProperty("agentsConnected").GetInt32());
        Assert.False(string.IsNullOrEmpty(body.GetProperty("version").GetString()));
        Assert.True(body.GetProperty("uptimeSec").GetInt64() >= 0);
    }

    [Fact]
    public async Task Readyz_is_503_without_mongo()
    {
        using var client = factory.CreateClient();
        var response = await client.GetAsync("/readyz", Repo.Timeout());

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Fact]
    public async Task Install_returns_a_shell_script()
    {
        using var client = factory.CreateClient();
        var response = await client.GetAsync("/install", Repo.Timeout());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/plain", response.Content.Headers.ContentType?.MediaType);
        var script = await response.Content.ReadAsStringAsync(Repo.Timeout());
        Assert.StartsWith("#!/bin/sh\n", script);
        // The real installer (apps/glimt-agent/install/install.sh): main() called last, this hub as the default, checksum verified.
        Assert.EndsWith("main \"$@\"\n", script);
        Assert.Contains("hub=\"ws://localhost:5080/agent/ws\"", script);
        Assert.Contains("version=\"${GLIMT_AGENT_VERSION:-latest}\"", script);
        Assert.Contains("sha256sum -c", script);
        Assert.Equal("public, max-age=3600", response.Headers.CacheControl?.ToString());
        Assert.Equal("wss://api.glimtpanel.com/agent/ws", ContainerSnippets.AgentWsUrl(new GlimtOptions { Env = GlimtOptions.E2e, MongoUri = HubFactory.UnreachableMongoUri, MongoDb = "t", JwtSecret = "t", HubUrl = "http://localhost:5080", HubPublicUrl = "https://api.glimtpanel.com/" }));
    }

    [Fact]
    public async Task Bodies_over_one_megabyte_and_deep_json_are_rejected()
    {
        // Step 11.2: Kestrel caps REST bodies at 1 MB (413) and System.Text.Json stops at depth 32 (400) before any handler runs.
        using var client = factory.CreateClient();
        var big = new StringContent("{\"email\":\"" + new string('a', 2 * 1024 * 1024) + "\"}", System.Text.Encoding.UTF8, "application/json");
        var tooLarge = await client.PostAsync("/api/auth/login", big, Repo.Timeout());
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooLarge.StatusCode);

        var deep = new StringContent(string.Concat(Enumerable.Repeat("{\"a\":", 40)) + "1" + new string('}', 40), System.Text.Encoding.UTF8, "application/json");
        var tooDeep = await client.PostAsync("/api/auth/login", deep, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, tooDeep.StatusCode);
    }

    [Fact]
    public async Task Agent_endpoint_requires_websocket_upgrade()
    {
        using var client = factory.CreateClient();
        var response = await client.GetAsync("/agent/ws", Repo.Timeout());

        Assert.Equal(HttpStatusCode.UpgradeRequired, response.StatusCode);
    }
}

/// <summary>POST /api/client-errors (step 9.5): anonymous, logged, 204; rate-limited per address.</summary>
public sealed class ClientErrorsTests(HubFactory factory) : IClassFixture<HubFactory>
{
    [Fact]
    public async Task Client_error_is_accepted_without_a_token()
    {
        using var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/client-errors", new { message = "TypeError: x is not a function", stack = "at foo (app.js:1:1)", url = "http://localhost:4200/", userAgent = "test", version = "0.1.0" }, Repo.Timeout());
        Assert.Equal(System.Net.HttpStatusCode.NoContent, response.StatusCode);
        var empty = await client.PostAsJsonAsync("/api/client-errors", new { }, Repo.Timeout());
        Assert.Equal(System.Net.HttpStatusCode.NoContent, empty.StatusCode);
    }
}
