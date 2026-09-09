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
