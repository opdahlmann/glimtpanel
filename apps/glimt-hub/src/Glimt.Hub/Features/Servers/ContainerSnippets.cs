using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Servers;

/// <summary>
/// The two setups a container node can be run with (IMPLEMENTERINGSPLAN steps 12.4 and 12.5), returned by
/// POST /api/servers together with the token: a sidecar in Compose, or the binary copied into the app's image.
/// </summary>
public static class ContainerSnippets
{
    public const string DefaultImage = "ghcr.io/opdahlmann/glimt-agent:latest";

    /// <summary>The agent's WebSocket URL from the hub's public address.</summary>
    public static string AgentWsUrl(GlimtOptions options)
    {
        var url = (options.HubPublicUrl ?? options.HubUrl).TrimEnd('/');
        if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            url = "wss://" + url["https://".Length..];
        }
        else if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            url = "ws://" + url["http://".Length..];
        }

        return url + Agents.AgentsFeature.WebSocketPath;
    }

    public static string Image(GlimtOptions options) => string.IsNullOrWhiteSpace(options.AgentImage) ? DefaultImage : options.AgentImage.Trim();

    /// <summary>docker-compose: the agent shares the app's pid and network namespaces (`pid`/`network_mode: service:app`).</summary>
    public static string Compose(string image, string hubWs, string token, string name) => $"""
        services:
          app:
            image: your-app:latest           # your service, unchanged

          glimt-agent:
            image: {image}
            pid: "service:app"
            network_mode: "service:app"
            read_only: true
            restart: unless-stopped
            environment:
              GLIMT_HUB: {hubWs}
              GLIMT_TOKEN: {token}
              GLIMT_NODE_NAME: {name}
              # GLIMT_HEALTH_URL: http://127.0.0.1:8080/healthz
              # GLIMT_CHECKS: db=postgres:5432,cache=redis:6379
              # GLIMT_LOG_PATHS: /var/log/app
        """;

    /// <summary>The binary in the app's own image, for platforms with one container per service (Cloud Run, Fargate, Railway…).</summary>
    public static string Dockerfile(string image, string hubWs, string token, string name) => $"""
        # Dockerfile: copy the agent in and start it before your app
        COPY --from={image} /glimt-agent /usr/local/bin/glimt-agent
        ENV GLIMT_HUB={hubWs} GLIMT_NODE_NAME={name}
        # Set GLIMT_TOKEN as a runtime secret on the platform rather than here:
        # ENV GLIMT_TOKEN={token}
        ENTRYPOINT ["/bin/sh", "-c", "glimt-agent run & exec \"$0\" \"$@\""]
        CMD ["your-app"]
        """;
}
