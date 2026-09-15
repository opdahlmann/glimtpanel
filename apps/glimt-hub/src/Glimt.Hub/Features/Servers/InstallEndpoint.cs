using System.Reflection;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Servers;

/// <summary>
/// GET /install: the agent installation script (apps/glimt-agent/install/install.sh, embedded at build time) with
/// this hub's WebSocket URL and GLIMT_AGENT_VERSION as defaults, so `curl -fsSL https://get.glimtpanel.com | sh -s -- --key gp_…`
/// needs nothing else (steps 1.11 and 11.3). Cached for an hour; the script itself verifies the binary's SHA-256.
/// </summary>
public static class InstallEndpoint
{
    public const string Path = "/install";
    private const string HubLine = "\thub=\"wss://api.glimtpanel.com/agent/ws\"\n";
    private const string VersionLine = "\tversion=\"${GLIMT_AGENT_VERSION:-latest}\"\n";

    private static readonly Lazy<string> Template = new(() =>
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("install.sh") ?? throw new InvalidOperationException("install.sh is not embedded");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd().Replace("\r\n", "\n");
    });

    public static IEndpointRouteBuilder MapInstall(this IEndpointRouteBuilder app)
    {
        app.MapGet(Path, (GlimtOptions options, HttpContext http) =>
        {
            http.Response.Headers.CacheControl = "public, max-age=3600";
            return Results.Text(Script(options), "text/plain");
        });
        return app;
    }

    /// <summary>The script with this hub's defaults filled in. Throws if the embedded script no longer has the two lines we patch.</summary>
    internal static string Script(GlimtOptions options)
    {
        var template = Template.Value;
        if (!template.Contains(HubLine, StringComparison.Ordinal) || !template.Contains(VersionLine, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("install.sh has changed: the hub and version defaults were not found");
        }

        return template
            .Replace(HubLine, "\thub=\"" + ContainerSnippets.AgentWsUrl(options) + "\"\n", StringComparison.Ordinal)
            .Replace(VersionLine, "\tversion=\"${GLIMT_AGENT_VERSION:-" + (options.AgentVersion ?? "latest") + "}\"\n", StringComparison.Ordinal);
    }
}
