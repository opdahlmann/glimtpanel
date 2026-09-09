using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Servers;

/// <summary>GET /install: the agent installation script. Placeholder until plan step 1.11.</summary>
public static class InstallEndpoint
{
    public const string Path = "/install";

    public static IEndpointRouteBuilder MapInstall(this IEndpointRouteBuilder app)
    {
        app.MapGet(Path, (GlimtOptions options) => Results.Text(Script(options), "text/plain"));
        return app;
    }

    internal static string Script(GlimtOptions options) =>
        "#!/bin/sh\n"
        + "# Glimtpanel agent installer. Placeholder: the install script comes in plan step 1.11.\n"
        + $"# hub: {options.HubPublicUrl ?? options.HubUrl}  agent version: {options.AgentVersion ?? "0.0.0"}\n"
        + "echo 'glimt-agent: the install script is not available yet (plan step 1.11)' >&2\n"
        + "exit 1\n";
}
