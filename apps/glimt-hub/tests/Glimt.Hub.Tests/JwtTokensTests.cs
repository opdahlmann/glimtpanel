using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Auth;
using Microsoft.Extensions.Time.Testing;

namespace Glimt.Hub.Tests;

public class JwtTokensTests
{
    private static GlimtOptions Options() => new()
    {
        Env = "e2e",
        MongoUri = "mongodb://127.0.0.1:1",
        MongoDb = "x",
        JwtSecret = "short-secret",
        HubUrl = "http://localhost:5080",
    };

    [Fact]
    public async Task Issued_token_validates_and_carries_user_claims()
    {
        // Validation uses the real clock inside the JWT handler, so issue relative to the real "now".
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow());
        var tokens = new JwtTokens(Options(), clock);

        var jwt = tokens.IssueAccessToken("u1", "ole@example.com", "Ole", "no");
        var principal = await tokens.ValidateAsync(jwt);

        Assert.NotNull(principal);
        Assert.Equal("u1", principal.GetUserId());
        Assert.Equal("ole@example.com", principal.GetEmail());
        Assert.Equal("no", principal.GetLanguage());
    }

    [Fact]
    public async Task Expired_token_is_rejected()
    {
        // Issued three minutes ago with a one-minute lifetime: expired even with the 30 s skew.
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow().AddMinutes(-3));
        var tokens = new JwtTokens(Options(), clock);
        var jwt = tokens.IssueAccessToken("u1", "a@b.c", "A", "en", TimeSpan.FromMinutes(1));

        var later = new JwtTokens(Options(), TimeProvider.System);
        Assert.Null(await later.ValidateAsync(jwt));
    }

    [Fact]
    public async Task Token_signed_with_other_secret_is_rejected()
    {
        var a = new JwtTokens(Options(), TimeProvider.System);
        var b = new JwtTokens(new GlimtOptions { Env = "e2e", MongoUri = "mongodb://127.0.0.1:1", MongoDb = "x", JwtSecret = "other", HubUrl = "http://localhost:5080" }, TimeProvider.System);
        var jwt = a.IssueAccessToken("u1", "a@b.c", "A", "en");
        Assert.Null(await b.ValidateAsync(jwt));
    }
}
