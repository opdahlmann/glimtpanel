using System.Net.Http.Headers;
using System.Text.Json;
using Glimt.Hub.Infrastructure.Auth;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Glimt.Hub.Tests;

/// <summary>JWTs, SignalR connections and agent-socket expectations shared by the Live/Agents/Buffer/Demo tests.</summary>
public static class LiveTestSupport
{
    public const string DevUserId = "u-dev";

    /// <summary>An access token signed by the hub under test (the same JwtTokens instance validates it).</summary>
    public static string Token(WebApplicationFactory<Program> app, string userId = DevUserId, string email = "dev@glimtpanel.local", TimeSpan? lifetime = null) =>
        app.Services.GetRequiredService<JwtTokens>().IssueAccessToken(userId, email, "Test", "en", lifetime);

    public static HubConnection Connect(WebApplicationFactory<Program> app, string token, bool messagePack = false)
    {
        var builder = new HubConnectionBuilder()
            .WithUrl(new Uri(app.Server.BaseAddress, "hub/live"), options =>
            {
                options.HttpMessageHandlerFactory = _ => app.Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
                options.AccessTokenProvider = () => Task.FromResult<string?>(token);
            });
        if (messagePack)
        {
            builder.AddMessagePackProtocol();
        }

        return builder.Build();
    }

    public static HttpClient Bearer(WebApplicationFactory<Program> app, string token)
    {
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    /// <summary>Connects an agent with the dev key and returns the socket after welcome.</summary>
    public static async Task<(AgentSocket Agent, string Token, string ServerId)> ConnectAgentAsync(HubFactory factory, string hostname, CancellationToken ct)
    {
        var hello = Repo.Hello();
        hello["hostname"] = hostname;
        var agent = await factory.ConnectAgentAsync(ct);
        await agent.SendAsync(hello, ct);
        var welcome = await agent.ReceiveAsync(ct);
        Assert.NotNull(welcome);
        Assert.Equal("welcome", welcome.Value.GetProperty("type").GetString());
        return (agent, welcome.Value.GetProperty("token").GetString()!, welcome.Value.GetProperty("serverId").GetString()!);
    }

    /// <summary>Reads messages until one of the wanted type arrives (pings are skipped). Null when the socket closed.</summary>
    public static async Task<JsonElement?> ExpectAsync(AgentSocket agent, string type, CancellationToken ct)
    {
        while (true)
        {
            var message = await agent.ReceiveAsync(ct);
            if (message is null)
            {
                return null;
            }

            var actual = message.Value.GetProperty("type").GetString();
            if (actual == type)
            {
                return message;
            }

            if (actual != "ping")
            {
                Assert.Fail($"expected {type} from the hub but got {message.Value.GetRawText()}");
            }
        }
    }

    /// <summary>Asserts that no message other than ping reaches the agent within the given time.</summary>
    public static async Task AssertQuietAsync(AgentSocket agent, TimeSpan window)
    {
        using var cts = new CancellationTokenSource(window);
        try
        {
            var message = await agent.ReceiveAsync(cts.Token);
            if (message is not null && message.Value.GetProperty("type").GetString() != "ping")
            {
                Assert.Fail("unexpected message to the agent: " + message.Value.GetRawText());
            }
        }
        catch (OperationCanceledException)
        {
            // quiet, as expected
        }
    }

    /// <summary>A synthetic stream frame: the snapshot's host block with a different cpu and a process list.</summary>
    public static System.Text.Json.Nodes.JsonObject Stream(double cpu, long? ts = null)
    {
        var snapshot = Repo.Example("snapshot").AsObject();
        var host = snapshot["host"]!.DeepClone().AsObject();
        host["cpu"]!["total"] = cpu;
        return new System.Text.Json.Nodes.JsonObject
        {
            ["type"] = "stream",
            ["ts"] = ts ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["host"] = host,
            ["containers"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["id"] = "a1b2c3", ["cpuPct"] = 7.5, ["memBytes"] = 500000000, ["state"] = "running" }),
            ["processes"] = new System.Text.Json.Nodes.JsonArray(
                new System.Text.Json.Nodes.JsonObject { ["pid"] = 1182, ["name"] = "nginx", ["user"] = "www-data", ["cpuPct"] = 3.2, ["rssBytes"] = 64000000, ["cmdline"] = "nginx: worker process" },
                new System.Text.Json.Nodes.JsonObject { ["pid"] = 812, ["name"] = "sshd", ["user"] = "root", ["cpuPct"] = 0.1, ["rssBytes"] = 9000000 }),
            ["processTotals"] = new System.Text.Json.Nodes.JsonObject { ["total"] = 181, ["running"] = 2, ["blocked"] = 0 },
        };
    }

    public static async Task<T> WaitAsync<T>(TaskCompletionSource<T> source, int seconds = 5) =>
        await source.Task.WaitAsync(TimeSpan.FromSeconds(seconds));
}
