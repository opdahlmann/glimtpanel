namespace Glimt.Hub.Infrastructure;

public static class LoggingSetup
{
    /// <summary>Console logging: human-readable in development, one JSON object per line in production.</summary>
    public static WebApplicationBuilder AddGlimtLogging(this WebApplicationBuilder builder, GlimtOptions options)
    {
        builder.Logging.ClearProviders();
        if (options.IsProduction)
        {
            builder.Logging.AddJsonConsole(o =>
            {
                o.UseUtcTimestamp = true;
                o.TimestampFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";
            });
        }
        else
        {
            builder.Logging.AddSimpleConsole(o =>
            {
                o.SingleLine = true;
                o.TimestampFormat = "HH:mm:ss ";
            });
        }

        return builder;
    }
}
