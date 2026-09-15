using System.Buffers.Text;
using Glimt.Hub.Infrastructure;
using Microsoft.Extensions.Configuration;

namespace Glimt.Hub.Tests;

public sealed class DotEnvTests
{
    [Fact]
    public void Parses_like_scripts_env_mjs()
    {
        var parsed = DotEnv.Parse(
        [
            "# comment",
            "",
            "GLIMT_ENV=development                      # development | e2e | production",
            "GLIMT_MAIL_FROM=Glimtpanel <no-reply@glimtpanel.com>",
            "GLIMT_QUOTED=\"a # not a comment\"",
            "GLIMT_SINGLE='x'",
            "GLIMT_EMPTY=",
            "=novalue",
            "GLIMT_URI=mongodb://u:p@h:27017/?authSource=admin",
        ]).ToDictionary(kv => kv.Key, kv => kv.Value);

        Assert.Equal("development", parsed["GLIMT_ENV"]);
        Assert.Equal("Glimtpanel <no-reply@glimtpanel.com>", parsed["GLIMT_MAIL_FROM"]);
        Assert.Equal("a # not a comment", parsed["GLIMT_QUOTED"]);
        Assert.Equal("x", parsed["GLIMT_SINGLE"]);
        Assert.Equal("", parsed["GLIMT_EMPTY"]);
        Assert.Equal("mongodb://u:p@h:27017/?authSource=admin", parsed["GLIMT_URI"]);
        Assert.Equal(6, parsed.Count);
    }

    [Fact]
    public void Finds_the_repo_root_by_example_env()
    {
        Assert.True(File.Exists(Path.Combine(Repo.Root, "example.env")));
        Assert.Null(DotEnv.FindRepoRoot(Path.GetTempPath()));
    }
}

public sealed class GlimtOptionsTests
{
    private static IConfiguration Config(params (string Key, string Value)[] values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values.Select(v => new KeyValuePair<string, string?>(v.Key, v.Value))).Build();

    [Fact]
    public void Missing_required_keys_are_listed_with_their_env_names()
    {
        var ex = Assert.Throws<GlimtConfigurationException>(() => GlimtOptions.FromConfiguration(Config(("MONGO_DB", "x"))));

        Assert.Contains("GLIMT_MONGO_URI", ex.Message);
        Assert.Contains("GLIMT_JWT_SECRET", ex.Message);
        Assert.DoesNotContain("GLIMT_MONGO_DB", ex.Message);
    }

    [Fact]
    public void Maps_upper_snake_keys_and_applies_defaults()
    {
        var options = GlimtOptions.FromConfiguration(Config(
            ("MONGO_URI", "mongodb://h"), ("MONGO_DB", "GlimtpanelDev"), ("JWT_SECRET", "s"),
            ("HEARTBEAT_SECONDS", "15"), ("DEMO_MODE", "true"), ("WEB_PUBLIC_URL", "http://localhost:4200"), ("ENV", "E2E")));

        Assert.Equal("e2e", options.Env);
        Assert.True(options.IsDevelopmentLike);
        Assert.False(options.IsProduction);
        Assert.Equal("http://localhost:5080", options.HubUrl);
        Assert.Equal(15, options.HeartbeatSeconds);
        Assert.Equal(120, options.DownAfterSeconds);
        Assert.True(options.DemoMode);
        Assert.Equal("http://localhost:4200", options.WebPublicUrl);
        Assert.Null(options.DevEnrolKey);
    }

    [Theory]
    [InlineData("ENV", "staging")]
    [InlineData("HEARTBEAT_SECONDS", "0")]
    [InlineData("DEMO_MODE", "yes")]
    [InlineData("HUB_URL", "5080")]
    public void Invalid_values_fail_fast(string key, string value)
    {
        var ex = Assert.Throws<GlimtConfigurationException>(() => GlimtOptions.FromConfiguration(Config(
            ("MONGO_URI", "mongodb://h"), ("MONGO_DB", "d"), ("JWT_SECRET", "s"), (key, value))));

        Assert.Contains("GLIMT_" + key, ex.Message);
    }
}

public sealed class VapidKeysTests
{
    [Fact]
    public void Generates_uncompressed_p256_public_key_and_32_byte_private_scalar()
    {
        var (publicKey, privateKey) = VapidKeys.Generate();

        var pub = Base64Url.DecodeFromChars(publicKey);
        var priv = Base64Url.DecodeFromChars(privateKey);
        Assert.Equal(65, pub.Length);
        Assert.Equal(0x04, pub[0]);
        Assert.Equal(32, priv.Length);
        Assert.DoesNotContain('=', publicKey);
    }

    [Fact]
    public void Subcommand_prints_env_lines_and_skips_the_host()
    {
        using var output = new StringWriter();

        Assert.True(VapidKeys.TryRun(["vapid-keys"], output));
        Assert.False(VapidKeys.TryRun([], output));
        Assert.False(VapidKeys.TryRun(["--urls", "http://x"], output));

        var lines = output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(2, lines.Length);
        Assert.StartsWith("GLIMT_VAPID_PUBLIC=", lines[0]);
        Assert.StartsWith("GLIMT_VAPID_PRIVATE=", lines[1]);
    }
}
