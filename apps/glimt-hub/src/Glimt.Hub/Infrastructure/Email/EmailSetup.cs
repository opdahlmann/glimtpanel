namespace Glimt.Hub.Infrastructure.Email;

public static class EmailSetup
{
    public static IServiceCollection AddGlimtEmail(this IServiceCollection services, GlimtOptions options)
    {
        // TODO(step 2.2): register AppmailEmailSender when GLIMT_APPMAIL_URL is set; console otherwise.
        services.AddSingleton<IEmailSender, ConsoleEmailSender>();
        return services;
    }
}
