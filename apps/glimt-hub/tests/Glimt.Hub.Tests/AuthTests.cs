using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Glimt.Hub.Infrastructure;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Glimt.Hub.Tests;

public sealed class AuthTests(TestHub hub) : IClassFixture<TestHub>
{
    [Fact]
    public async Task Register_confirm_and_me()
    {
        var email = TestUsers.NewEmail("reg");
        using var client = hub.CreateClient();

        var register = await client.PostAsJsonAsync("/api/auth/register", new { email = " " + email.ToUpperInvariant() + " ", password = TestUsers.DefaultPassword, name = " Ola Nordmann " }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Created, register.StatusCode);
        var created = await register.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal(email, created.GetProperty("email").GetString());
        Assert.Equal("Ola Nordmann", created.GetProperty("name").GetString());
        Assert.False(created.GetProperty("emailConfirmed").GetBoolean());
        Assert.True(created.GetProperty("earlyAdopter").GetBoolean());
        Assert.Equal("beta", created.GetProperty("plan").GetString());

        var mail = hub.Mails.Last(email);
        Assert.Contains("http://localhost:4200/confirm?token=", mail.Text);
        Assert.Contains("Confirm", mail.Subject);
        var token = hub.Mails.TokenFor(email, "/confirm");

        var confirm = await client.PostAsJsonAsync("/api/auth/confirm", new { token }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, confirm.StatusCode);
        var cookie = confirm.Headers.GetValues("Set-Cookie").Single(h => h.StartsWith("glimt_refresh=", StringComparison.Ordinal));
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("path=/api/auth", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", cookie, StringComparison.OrdinalIgnoreCase);
        var login = await confirm.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.True(login.GetProperty("user").GetProperty("emailConfirmed").GetBoolean());
        Assert.True(login.GetProperty("expiresAt").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddMinutes(10));

        // the confirmation link is single-use
        var again = await client.PostAsJsonAsync("/api/auth/confirm", new { token }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.GetProperty("accessToken").GetString());
        var me = await client.GetFromJsonAsync<JsonElement>("/api/auth/me", Repo.Timeout());
        Assert.Equal(email, me.GetProperty("email").GetString());
        Assert.True(me.GetProperty("emailConfirmed").GetBoolean());
        Assert.False(me.GetProperty("ownsServers").GetBoolean());
        Assert.Equal(0, me.GetProperty("readerOf").GetInt32());
        Assert.Equal("Europe/Oslo", me.GetProperty("timezone").GetString());
        Assert.Equal("en", me.GetProperty("language").GetString());
    }

    [Fact]
    public async Task Register_validates_input_and_rejects_duplicates()
    {
        using var client = hub.CreateClient();
        var bad = await client.PostAsJsonAsync("/api/auth/register", new { email = "not-an-email", password = "short", name = "" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var problem = await bad.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        var errors = problem.GetProperty("errors");
        Assert.True(errors.TryGetProperty("email", out _));
        Assert.True(errors.TryGetProperty("password", out _));
        Assert.True(errors.TryGetProperty("name", out _));

        var common = await client.PostAsJsonAsync("/api/auth/register", new { email = TestUsers.NewEmail(), password = "password123", name = "X" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, common.StatusCode);
        var commonProblem = await common.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Contains("common", commonProblem.GetProperty("errors").GetProperty("password")[0].GetString());

        using var user = await TestUsers.RegisterAndConfirmAsync(hub);
        var duplicate = await client.PostAsJsonAsync("/api/auth/register", new { email = user.Email.ToUpperInvariant(), password = TestUsers.DefaultPassword, name = "Dup" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
        var dupProblem = await duplicate.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("emailTaken", dupProblem.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Login_rejects_wrong_password_unknown_email_and_unconfirmed_account()
    {
        using var client = hub.CreateClient();
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);

        var wrong = await client.PostAsJsonAsync("/api/auth/login", new { email = user.Email, password = "definitely-not-it" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);

        var unknown = await client.PostAsJsonAsync("/api/auth/login", new { email = "nobody@test.local", password = TestUsers.DefaultPassword }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Unauthorized, unknown.StatusCode);

        var unconfirmedEmail = TestUsers.NewEmail("unconfirmed");
        var register = await client.PostAsJsonAsync("/api/auth/register", new { email = unconfirmedEmail, password = TestUsers.DefaultPassword, name = "Pending" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Created, register.StatusCode);
        var unconfirmed = await client.PostAsJsonAsync("/api/auth/login", new { email = unconfirmedEmail, password = TestUsers.DefaultPassword }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Forbidden, unconfirmed.StatusCode);
        var problem = await unconfirmed.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.Equal("emailNotConfirmed", problem.GetProperty("code").GetString());

        // resend gives a fresh link that works
        var resend = await client.PostAsJsonAsync("/api/auth/resend-confirmation", new { email = unconfirmedEmail }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.NoContent, resend.StatusCode);
        var confirm = await client.PostAsJsonAsync("/api/auth/confirm", new { token = hub.Mails.TokenFor(unconfirmedEmail, "/confirm") }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, confirm.StatusCode);
    }

    [Fact]
    public async Task Dev_user_seeded_by_DevSeeder_can_log_in()
    {
        using var client = hub.CreateClient();
        var deadline = DateTime.UtcNow.AddSeconds(10);
        HttpResponseMessage response;
        do
        {
            response = await client.PostAsJsonAsync("/api/auth/login", new { email = "dev@glimtpanel.local", password = "test-password" }, Repo.Timeout());
        }
        while (response.StatusCode != HttpStatusCode.OK && DateTime.UtcNow < deadline && await Delay());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        static async Task<bool> Delay()
        {
            await Task.Delay(200);
            return true;
        }
    }

    [Fact]
    public async Task Refresh_cookie_is_secure_behind_a_tls_proxy()
    {
        // Dokploy: TLS ends in Traefik; nginx and the hub speak plain HTTP, so X-Forwarded-Proto decides Secure.
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);
        using var client = hub.CreateClient(handleCookies: false);
        var plain = await client.PostAsJsonAsync("/api/auth/login", new { email = user.Email, password = user.Password }, Repo.Timeout());
        Assert.DoesNotContain("secure", plain.Headers.GetValues("Set-Cookie").Single(h => h.StartsWith("glimt_refresh=", StringComparison.Ordinal)), StringComparison.OrdinalIgnoreCase);

        client.DefaultRequestHeaders.Add("X-Forwarded-Proto", "https");
        client.DefaultRequestHeaders.Add("X-Forwarded-For", "203.0.113.9, 10.0.0.2");
        var tls = await client.PostAsJsonAsync("/api/auth/login", new { email = user.Email, password = user.Password }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, tls.StatusCode);
        Assert.Contains("secure", tls.Headers.GetValues("Set-Cookie").Single(h => h.StartsWith("glimt_refresh=", StringComparison.Ordinal)), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Refresh_rotates_and_detects_reuse()
    {
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);
        using var client = hub.CreateClient(handleCookies: false);
        var (_, first) = await TestUsers.LoginRawAsync(client, user.Email, user.Password);

        var missing = await client.PostAsync("/api/auth/refresh", null, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Unauthorized, missing.StatusCode);

        var refresh = await client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh").WithCookie(first), Repo.Timeout());
        Assert.Equal(HttpStatusCode.OK, refresh.StatusCode);
        var body = await refresh.Content.ReadFromJsonAsync<JsonElement>(Repo.Timeout());
        Assert.False(string.IsNullOrEmpty(body.GetProperty("accessToken").GetString()));
        var second = TestUsers.RefreshCookie(refresh);
        Assert.NotEqual(first, second);

        // the rotated-away token is rejected, and its reuse revokes the whole family
        var reuse = await client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh").WithCookie(first), Repo.Timeout());
        Assert.Equal(HttpStatusCode.Unauthorized, reuse.StatusCode);
        var afterReuse = await client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh").WithCookie(second), Repo.Timeout());
        Assert.Equal(HttpStatusCode.Unauthorized, afterReuse.StatusCode);
    }

    [Fact]
    public async Task Logout_revokes_the_refresh_token_and_clears_the_cookie()
    {
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);
        using var client = hub.CreateClient(handleCookies: false);
        var (_, cookie) = await TestUsers.LoginRawAsync(client, user.Email, user.Password);

        var logout = await client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout").WithCookie(cookie), Repo.Timeout());
        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);
        var cleared = logout.Headers.GetValues("Set-Cookie").Single(h => h.StartsWith("glimt_refresh=", StringComparison.Ordinal));
        Assert.Contains("expires=", cleared, StringComparison.OrdinalIgnoreCase);

        var refresh = await client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh").WithCookie(cookie), Repo.Timeout());
        Assert.Equal(HttpStatusCode.Unauthorized, refresh.StatusCode);
    }

    [Fact]
    public async Task Logout_all_revokes_every_session()
    {
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);
        using var client = hub.CreateClient(handleCookies: false);
        var (_, a) = await TestUsers.LoginRawAsync(client, user.Email, user.Password);
        var (access, b) = await TestUsers.LoginRawAsync(client, user.Email, user.Password);

        var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout-all");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(request, Repo.Timeout())).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh").WithCookie(a), Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh").WithCookie(b), Repo.Timeout())).StatusCode);
    }

    [Fact]
    public async Task Forgot_and_reset_password()
    {
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);
        using var client = hub.CreateClient(handleCookies: false);
        var (_, cookie) = await TestUsers.LoginRawAsync(client, user.Email, user.Password);

        var unknown = await client.PostAsJsonAsync("/api/auth/forgot", new { email = "nobody@test.local" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.NoContent, unknown.StatusCode);

        var forgot = await client.PostAsJsonAsync("/api/auth/forgot", new { email = user.Email }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.NoContent, forgot.StatusCode);
        var token = hub.Mails.TokenFor(user.Email, "/reset");

        var weak = await client.PostAsJsonAsync("/api/auth/reset", new { token, password = "short" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, weak.StatusCode);

        const string newPassword = "a-brand-new-password-42";
        var reset = await client.PostAsJsonAsync("/api/auth/reset", new { token, password = newPassword }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);

        var reused = await client.PostAsJsonAsync("/api/auth/reset", new { token, password = newPassword }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, reused.StatusCode);

        // old sessions are gone, the old password no longer works, the new one does
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh").WithCookie(cookie), Repo.Timeout())).StatusCode);
        var old = await client.PostAsJsonAsync("/api/auth/login", new { email = user.Email, password = user.Password }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Unauthorized, old.StatusCode);
        await TestUsers.LoginRawAsync(client, user.Email, newPassword);
    }

    [Fact]
    public async Task Change_password_requires_the_current_one()
    {
        using var user = await TestUsers.RegisterAndConfirmAsync(hub);

        var wrong = await user.Client.PostAsJsonAsync("/api/auth/password", new { currentPassword = "nope-nope-nope", newPassword = "another-long-password" }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);

        const string newPassword = "another-long-password";
        var change = await user.Client.PostAsJsonAsync("/api/auth/password", new { currentPassword = user.Password, newPassword }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.NoContent, change.StatusCode);

        using var client = hub.CreateClient();
        var old = await client.PostAsJsonAsync("/api/auth/login", new { email = user.Email, password = user.Password }, Repo.Timeout());
        Assert.Equal(HttpStatusCode.Unauthorized, old.StatusCode);
        await TestUsers.LoginRawAsync(client, user.Email, newPassword);
    }

    [Fact]
    public async Task Bearer_endpoints_reject_anonymous_requests()
    {
        using var client = hub.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/auth/me", Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/account", Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/servers", Repo.Timeout())).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/access", Repo.Timeout())).StatusCode);
    }

    [Theory]
    [InlineData("/api/auth/register", RateLimiting.AuthPolicy)]
    [InlineData("/api/auth/login", RateLimiting.AuthPolicy)]
    [InlineData("/api/auth/forgot", RateLimiting.AuthPolicy)]
    [InlineData("/api/auth/reset", RateLimiting.AuthPolicy)]
    [InlineData("/api/auth/confirm", RateLimiting.AuthPolicy)]
    [InlineData("/api/auth/resend-confirmation", RateLimiting.AuthPolicy)]
    [InlineData("/api/auth/refresh", RateLimiting.ApiPolicy)]
    [InlineData("/api/auth/me", RateLimiting.ApiPolicy)]
    [InlineData("/api/servers", RateLimiting.ApiPolicy)]
    [InlineData("/api/access", RateLimiting.ApiPolicy)]
    public void Rate_limit_policy_is_attached(string path, string policy)
    {
        var endpoints = hub.Services.GetServices<EndpointDataSource>().SelectMany(s => s.Endpoints).OfType<RouteEndpoint>();
        var endpoint = endpoints.First(e => e.RoutePattern.RawText?.TrimEnd('/') == path);
        Assert.Equal(policy, endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName);
    }
}
