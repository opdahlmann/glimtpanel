using Glimt.Hub.Features.Access;
using Glimt.Hub.Features.Account;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Alerts;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Buffer;
using Glimt.Hub.Features.Demo;
using Glimt.Hub.Features.Groups;
using Glimt.Hub.Features.Health;
using Glimt.Hub.Features.Live;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Email;
using Microsoft.AspNetCore.HttpOverrides;

if (VapidKeys.TryRun(args, Console.Out))
{
    return 0;
}

var dotEnv = DotEnv.LoadIfNeeded();

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    EnvironmentName = GlimtOptions.AspNetEnvironmentName(Environment.GetEnvironmentVariable("GLIMT_ENV")),
});
builder.Configuration.AddEnvironmentVariables("GLIMT_");

GlimtOptions options;
try
{
    options = GlimtOptions.FromConfiguration(builder.Configuration);
}
catch (GlimtConfigurationException ex)
{
    Console.Error.WriteLine(ex.Message);
    return 1;
}

builder.WebHost.UseUrls(options.HubUrl);
// Steg 11.2: ingen REST-kropp over 1 MB (413); WebSocket-rammer har egen grense i AgentSocket.
builder.WebHost.ConfigureKestrel(kestrel => kestrel.Limits.MaxRequestBodySize = RequestLimits.MaxBodyBytes);
builder.Services.Configure<HostOptions>(host => host.ShutdownTimeout = TimeSpan.FromSeconds(8));
builder.AddGlimtLogging(options);
builder.Services
    .AddGlimtInfrastructure(options)
    .AddGlimtEmail(options)
    .AddGlimtRateLimiting(options)
    .AddAuthFeature(options)
    .AddAccountFeature()
    .AddAccessFeature()
    .AddAgentsFeature()
    .AddAlertsFeature()
    .AddBufferFeature(options)
    .AddLiveFeature(options)
    .AddServersFeature()
    .AddGroupsFeature()
    .AddDemoFeature(options);

var app = builder.Build();

var log = app.Logger;
log.LogInformation("glimt-hub {Version} starting: env={Env} url={HubUrl} db={MongoDb}", HealthFeature.Version, options.Env, options.HubUrl, options.MongoDb);
if (dotEnv.LoadedFiles.Count > 0)
{
    log.LogInformation("loaded {Count} variables from {Files}", dotEnv.AppliedKeys, string.Join(", ", dotEnv.LoadedFiles));
}

// Bak Traefik og nginx (Dokploy): IsHttps og RemoteIpAddress fra X-Forwarded-Proto/-For, ellers får oppfriskningskaken
// ikke Secure og hastighetsbegrensningen ser nginx sin adresse for alle. Alle proxyer stoles på (porten er ikke
// publisert), og hele kjeden client, traefik leses (ForwardLimit = null).
var forwarded = new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto, ForwardLimit = null };
forwarded.KnownIPNetworks.Clear();
forwarded.KnownProxies.Clear();
app.UseForwardedHeaders(forwarded);
app.UseBodyLimit();
app.UseLiveCors(options);
app.UseAuthentication();
app.UseDemoReadOnly(options);
app.UseAuthorization();
app.UseRateLimiter();
app.MapHealthFeature();
app.MapAuthFeature();
app.MapAccountFeature();
app.MapAccessFeature();
app.MapAgentsFeature();
app.MapAlertsFeature();
app.MapBufferFeature();
app.MapLiveFeature();
app.MapServersFeature();
app.MapGroupsFeature();
app.MapDemoFeature();

app.Run();
return 0;

/// <summary>Exposed for WebApplicationFactory in the test project.</summary>
public partial class Program;
