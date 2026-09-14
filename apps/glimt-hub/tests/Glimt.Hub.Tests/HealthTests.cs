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
    public async Task Install_returns_a_shell_script()
    {
        using var client = factory.CreateClient();
        var response = await client.GetAsync("/install", Repo.Timeout());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/plain", response.Content.Headers.ContentType?.MediaType);
        var script = await response.Content.ReadAsStringAsync(Repo.Timeout());
        Assert.StartsWith("#!/bin/sh\n", script);
        Assert.Contains("1.11", script);
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
