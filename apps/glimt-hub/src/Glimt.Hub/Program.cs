using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Health;
using Glimt.Hub.Features.Live;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;

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
builder.Services.Configure<HostOptions>(host => host.ShutdownTimeout = TimeSpan.FromSeconds(8));
builder.AddGlimtLogging(options);
builder.Services
    .AddGlimtInfrastructure(options)
    .AddAgentsFeature()
    .AddLiveFeature(options)
    .AddServersFeature();

var app = builder.Build();

var log = app.Logger;
log.LogInformation("glimt-hub {Version} starting: env={Env} url={HubUrl} db={MongoDb}", HealthFeature.Version, options.Env, options.HubUrl, options.MongoDb);
if (dotEnv.LoadedFiles.Count > 0)
{
    log.LogInformation("loaded {Count} variables from {Files}", dotEnv.AppliedKeys, string.Join(", ", dotEnv.LoadedFiles));
}

app.UseLiveCors(options);
app.MapHealthFeature();
app.MapAgentsFeature();
app.MapLiveFeature();
app.MapServersFeature();

app.Run();
return 0;

/// <summary>Exposed for WebApplicationFactory in the test project.</summary>
public partial class Program;
