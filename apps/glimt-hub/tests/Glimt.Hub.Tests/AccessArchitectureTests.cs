using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Glimt.Hub.Tests;

/// <summary>
/// Architecture test (step 11.2): every endpoint that names a server or a group in its route must go through
/// IAccessService. Instead of reading the code, it enumerates the routing table and calls each such endpoint as a
/// confirmed user who has no relation to the owner's server and group: the answer must be 403 or 404, never 2xx and
/// never a validation error (which would mean the body was inspected before access was checked).
/// </summary>
public sealed class AccessArchitectureTests(TestHub hub) : IClassFixture<TestHub>
{
    [Fact]
    public async Task Every_server_and_group_endpoint_denies_a_stranger_before_anything_else()
    {
        var ct = Repo.Timeout(60);
        using var owner = await TestUsers.RegisterAndConfirmAsync(hub);
        using var stranger = await TestUsers.RegisterAndConfirmAsync(hub);
        var server = await hub.AddServerAsync(owner.Id, "arch-" + Guid.NewGuid().ToString("N")[..6]);
        var created = await owner.Client.PostAsJsonAsync("/api/groups", new { name = "Arch", memberIds = new[] { server.Id } }, ct);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var groupId = (await created.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("id").GetString()!;

        var checked_ = new List<string>();
        var wrong = new List<string>();
        foreach (var endpoint in hub.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>())
        {
            var pattern = endpoint.RoutePattern.RawText ?? "";
            var isServer = pattern.StartsWith("/api/servers/{id}", StringComparison.Ordinal);
            var isGroup = pattern.StartsWith("/api/groups/{id}", StringComparison.Ordinal);
            if (!isServer && !isGroup)
            {
                continue;
            }

            var url = pattern.Replace("{id}", isServer ? server.Id : groupId, StringComparison.Ordinal);
            url = System.Text.RegularExpressions.Regex.Replace(url, "\\{[^}]+\\}", "x");
            foreach (var method in endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? ["GET"])
            {
                using var request = new HttpRequestMessage(new HttpMethod(method), url);
                if (method is not "GET" and not "DELETE")
                {
                    request.Content = JsonContent.Create(new { });
                }

                var response = await stranger.Client.SendAsync(request, ct);
                var label = $"{method} {pattern} → {(int)response.StatusCode}";
                checked_.Add(label);
                if (response.StatusCode is not (HttpStatusCode.Forbidden or HttpStatusCode.NotFound))
                {
                    wrong.Add(label);
                }
            }
        }

        Assert.True(checked_.Count >= 10, "expected at least ten server/group endpoints, found:\n" + string.Join("\n", checked_));
        Assert.True(wrong.Count == 0, "endpoints that did not deny the stranger with 403/404:\n" + string.Join("\n", wrong));
    }
}
