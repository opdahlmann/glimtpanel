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
            jwt.TokenValidationParameters = new JwtTokens(options, TimeProvider.System).ValidationParameters;
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
        services.AddAuthorization();
        // TODO(step 2.2): AuthService, refresh tokens, e-mail confirmation, rate limiting, endpoints.
        return services;
    }

    public static IEndpointRouteBuilder MapAuthFeature(this IEndpointRouteBuilder app)
    {
        // TODO(step 2.2): POST /api/auth/register|confirm|login|refresh|logout|forgot|reset|password, GET /api/auth/me
        return app;
    }
}
