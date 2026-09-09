namespace Glimt.Hub.Infrastructure.Email;

public static class EmailSetup
{
    /// <summary>Appmail over HTTP when GLIMT_APPMAIL_URL is set; otherwise the console sender (development).</summary>
    public static IServiceCollection AddGlimtEmail(this IServiceCollection services, GlimtOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.AppmailUrl))
        {
            services.AddSingleton<IEmailSender, ConsoleEmailSender>();
            return services;
        }

        services.AddHttpClient(AppmailEmailSender.ClientName, client => client.Timeout = AppmailEmailSender.Timeout);
        services.AddSingleton<IEmailSender, AppmailEmailSender>();
        return services;
    }
}
