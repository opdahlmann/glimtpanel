using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Glimt.Hub.Infrastructure;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Glimt.Hub.Tests;

/// <summary>
/// Hosts the hub in-process with an unreachable MongoDB, so every test runs without a database.
/// The values are set as process environment variables because that is the only configuration
/// source the hub reads (and it also stops DotEnv from loading the repo's .env files).
/// </summary>
public sealed class HubFactory : WebApplicationFactory<Program>
{
    public const string EnrolKey = "gp_test";
    public const string MongoUri = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&connectTimeoutMS=200";

    public HubFactory()
    {
        Environment.SetEnvironmentVariable("GLIMT_MONGO_URI", MongoUri);
        Environment.SetEnvironmentVariable("GLIMT_MONGO_DB", "GlimtpanelTest");
        Environment.SetEnvironmentVariable("GLIMT_JWT_SECRET", "test");
        Environment.SetEnvironmentVariable("GLIMT_ENV", "e2e");
        Environment.SetEnvironmentVariable("GLIMT_DEV_ENROL_KEY", EnrolKey);
        Environment.SetEnvironmentVariable("GLIMT_DEV_USER_EMAIL", "dev@glimtpanel.local");
        Environment.SetEnvironmentVariable("GLIMT_DEV_USER_PASSWORD", "test-password");
        Environment.SetEnvironmentVariable("GLIMT_WEB_PUBLIC_URL", "http://localhost:4200");
    }

    /// <summary>Opens an agent WebSocket against the in-memory server.</summary>
    public async Task<AgentSocket> ConnectAgentAsync(CancellationToken cancellationToken)
    {
        var client = Server.CreateWebSocketClient();
        var socket = await client.ConnectAsync(new Uri("ws://localhost/agent/ws"), cancellationToken);
        return new AgentSocket(socket);
    }
}

/// <summary>Small JSON-over-WebSocket helper that speaks like the Go agent will.</summary>
public sealed class AgentSocket(WebSocket socket) : IAsyncDisposable
{
    public WebSocket Socket => socket;

    public async Task SendAsync(JsonNode message, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
    }

    public async Task SendRawAsync(string json, CancellationToken cancellationToken)
    {
        await socket.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, cancellationToken);
    }

    /// <summary>Receives one text message, or null when the server closed the socket.</summary>
    public async Task<JsonElement?> ReceiveAsync(CancellationToken cancellationToken)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            message.Write(buffer, 0, result.Count);
        }
        while (!result.EndOfMessage);

        using var document = JsonDocument.Parse(message.ToArray());
        return document.RootElement.Clone();
    }

    public async Task CloseAsync(CancellationToken cancellationToken)
    {
        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "test done", cancellationToken);
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await CloseAsync(cts.Token);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            // already gone
        }

        socket.Dispose();
    }
}

public static class Repo
{
    /// <summary>Repo root, found by walking up from the test binaries to example.env.</summary>
    public static string Root { get; } =
        DotEnv.FindRepoRoot(AppContext.BaseDirectory)
        ?? throw new InvalidOperationException("example.env not found above " + AppContext.BaseDirectory);

    public static string ExamplesDir => Path.Combine(Root, "packages", "protocol", "examples");

    public static JsonNode Example(string name) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(ExamplesDir, name + ".json")))
        ?? throw new InvalidOperationException($"example {name} is empty");

    /// <summary>hello.json from the protocol examples with the enrol key replaced by the test key.</summary>
    public static JsonObject Hello(string? enrolKey = HubFactory.EnrolKey, string? token = null)
    {
        var hello = Example("hello").AsObject();
        hello.Remove("enrolKey");
        hello.Remove("token");
        if (enrolKey is not null)
        {
            hello["enrolKey"] = enrolKey;
        }

        if (token is not null)
        {
            hello["token"] = token;
        }

        return hello;
    }

    public static CancellationToken Timeout(int seconds = 10) => new CancellationTokenSource(TimeSpan.FromSeconds(seconds)).Token;
}
