using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Email;
using Glimt.Hub.Infrastructure.Servers;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;

namespace Glimt.Hub.Tests;

/// <summary>
/// A hub against the shared Testcontainers MongoDB (own database per fixture) with the e-mail sender and the
/// server lifecycle replaced by recording fakes. Use as <c>IClassFixture&lt;TestHub&gt;</c>.
/// </summary>
public sealed class TestHub : IAsyncLifetime
{
    private HubFactory? _root;
    private WebApplicationFactory<Program>? _app;

    public CapturingEmailSender Mails { get; } = new();

    public RecordingServerLifecycle Lifecycle { get; } = new();

    public WebApplicationFactory<Program> App => _app ?? throw new InvalidOperationException("not initialised");

    public IServiceProvider Services => App.Services;

    public MongoContext Mongo => Services.GetRequiredService<MongoContext>();

    public async Task InitializeAsync()
    {
        _root = HubFactory.WithMongo();
        _app = _root.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<IEmailSender>(Mails);
            services.AddSingleton<IServerLifecycle>(Lifecycle);
        }));

        Assert.True(await Mongo.Ready.WaitAsync(TimeSpan.FromSeconds(30)), "mongo should be reachable");
        await Services.GetRequiredService<MongoIndexes>().Done.WaitAsync(TimeSpan.FromSeconds(30));
    }

    public Task DisposeAsync()
    {
        _app?.Dispose();
        _root?.Dispose();
        return Task.CompletedTask;
    }

    /// <summary>A client; cookies are handled automatically unless <paramref name="handleCookies"/> is false.</summary>
    public HttpClient CreateClient(bool handleCookies = true) =>
        App.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = handleCookies });

    /// <summary>Inserts a server document directly (as an enrolled agent would have created it).</summary>
    public async Task<ServerDocument> AddServerAsync(string? ownerId, string name, IEnumerable<string>? tags = null, string? ubuntuVersion = "24.04", string? status = "down")
    {
        var doc = new ServerDocument
        {
            Id = ServerIds.New(),
            OwnerId = ownerId,
            Hostname = name,
            Name = name,
            Tags = tags?.ToList() ?? [],
            TokenHash = Features.Auth.Tokens.Hash(Features.Agents.AgentTokens.Generate()),
            Status = status ?? "down",
            Os = ubuntuVersion is null ? null : new OsDocument { Id = "ubuntu", VersionId = ubuntuVersion, PrettyName = $"Ubuntu {ubuntuVersion} LTS" },
            Arch = "amd64",
            Cores = 2,
            RamBytes = 4L * 1024 * 1024 * 1024,
            DockerMode = "proxy",
            CreatedAt = DateTime.UtcNow,
        };
        await Mongo.Db.GetCollection<ServerDocument>(ServerDocument.Collection).InsertOneAsync(doc);
        return doc;
    }

    public IMongoCollection<T> Collection<T>(string name) => Mongo.Db.GetCollection<T>(name);
}

/// <summary>Keeps every mail so tests can pull the tokens out of the links.</summary>
public sealed class CapturingEmailSender : IEmailSender
{
    private readonly ConcurrentQueue<EmailMessage> _messages = new();

    public IReadOnlyList<EmailMessage> Messages => _messages.ToArray();

    public Task<bool> SendAsync(EmailMessage message, CancellationToken cancellationToken)
    {
        _messages.Enqueue(message);
        return Task.FromResult(true);
    }

    public EmailMessage Last(string to) =>
        _messages.LastOrDefault(m => m.To == to) ?? throw new InvalidOperationException($"no mail to {to}");

    /// <summary>The token in the last mail to the address whose link contains the given path (e.g. "/confirm").</summary>
    public string TokenFor(string to, string path)
    {
        var mail = _messages.LastOrDefault(m => m.To == to && m.Text.Contains(path + "?token=", StringComparison.Ordinal))
            ?? throw new InvalidOperationException($"no mail to {to} with a {path} link");
        var match = Regex.Match(mail.Text, Regex.Escape(path) + @"\?token=([^\s&]+)");
        return Uri.UnescapeDataString(match.Groups[1].Value);
    }
}

/// <summary>Records what the Servers/Account features tell the agent side.</summary>
public sealed class RecordingServerLifecycle : IServerLifecycle
{
    public ConcurrentQueue<string> Removed { get; } = new();

    public ConcurrentQueue<(string ServerId, string Token, string TokenHash)> Rotated { get; } = new();

    public Task ServerRemovedAsync(string serverId, CancellationToken cancellationToken)
    {
        Removed.Enqueue(serverId);
        return Task.CompletedTask;
    }

    public Task TokenRotatedAsync(string serverId, string newToken, string newTokenHash, CancellationToken cancellationToken)
    {
        Rotated.Enqueue((serverId, newToken, newTokenHash));
        return Task.CompletedTask;
    }
}

/// <summary>A registered, confirmed user with an authenticated client.</summary>
public sealed record TestUser(string Id, string Email, string Password, string Name, HttpClient Client) : IDisposable
{
    public void Dispose() => Client.Dispose();
}

public static class TestUsers
{
    public const string DefaultPassword = "correct-horse-battery-staple";

    public static string NewEmail(string prefix = "user") => $"{prefix}-{Guid.NewGuid():N}"[..(prefix.Length + 9)] + "@test.local";

    /// <summary>Registers and confirms a user through the endpoints and returns a client with the Bearer token set.</summary>
    public static async Task<TestUser> RegisterAndConfirmAsync(TestHub hub, string? email = null, string password = DefaultPassword, string name = "Test User")
    {
        email ??= NewEmail();
        var client = hub.CreateClient();
        var register = await client.PostAsJsonAsync("/api/auth/register", new { email, password, name }, Repo.Timeout());
        Assert.Equal(System.Net.HttpStatusCode.Created, register.StatusCode);

        var token = hub.Mails.TokenFor(email, "/confirm");
        var confirm = await client.PostAsJsonAsync("/api/auth/confirm", new { token }, Repo.Timeout());
        Assert.Equal(System.Net.HttpStatusCode.OK, confirm.StatusCode);
        var body = await confirm.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        var accessToken = body.GetProperty("accessToken").GetString()!;
        var id = body.GetProperty("user").GetProperty("id").GetString()!;
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return new TestUser(id, email, password, name, client);
    }

    /// <summary>Logs in with a cookie-less client and returns the access token and the raw refresh cookie value.</summary>
    public static async Task<(string AccessToken, string RefreshCookie)> LoginRawAsync(HttpClient client, string email, string password)
    {
        var response = await client.PostAsJsonAsync("/api/auth/login", new { email, password }, Repo.Timeout());
        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        return (body.GetProperty("accessToken").GetString()!, RefreshCookie(response));
    }

    public static string RefreshCookie(HttpResponseMessage response)
    {
        var header = response.Headers.GetValues("Set-Cookie").First(h => h.StartsWith("glimt_refresh=", StringComparison.Ordinal));
        return header["glimt_refresh=".Length..header.IndexOf(';')];
    }

    public static HttpRequestMessage WithCookie(this HttpRequestMessage request, string refreshCookie)
    {
        request.Headers.Add("Cookie", "glimt_refresh=" + refreshCookie);
        return request;
    }
}
