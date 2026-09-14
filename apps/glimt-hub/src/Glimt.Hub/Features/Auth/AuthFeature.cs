using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Auth;
using Microsoft.AspNetCore.Authentication.JwtBearer;

namespace Glimt.Hub.Features.Auth;

public static class AuthFeature
{
    /// <summary>Bearer JWT for /api, and the same token from the access_token query string for SignalR (/hub).</summary>
    public static IServiceCollection AddAuthFeature(this IServiceCollection services, GlimtOptions options)
    {
        services.AddSingleton<JwtTokens>();
        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(jwt =>
        {
            jwt.MapInboundClaims = false;
            jwt.Events = new JwtBearerEvents
            {
                OnMessageReceived = context =>
                {
                    var token = context.Request.Query["access_token"];
                    if (!string.IsNullOrEmpty(token) && context.HttpContext.Request.Path.StartsWithSegments("/hub"))
                    {
                        context.Token = token;
                    }

                    return Task.CompletedTask;
                },
            };
        });
        // The validation parameters come from the same JwtTokens (and clock) that issues the tokens.
        services.AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme)
            .Configure<JwtTokens>((jwt, tokens) => jwt.TokenValidationParameters = tokens.ValidationParameters);
        services.AddAuthorization();
        services.AddSingleton<UserStore>();
        services.AddSingleton<IUserLookup>(sp => sp.GetRequiredService<UserStore>());
        services.AddSingleton<RefreshTokenStore>();
        services.AddSingleton<EmailTokenStore>();
        services.AddSingleton<AuthSessions>();
        return services;
    }

    public static IEndpointRouteBuilder MapAuthFeature(this IEndpointRouteBuilder app)
    {
        app.MapAuthEndpoints();
        return app;
    }
}
