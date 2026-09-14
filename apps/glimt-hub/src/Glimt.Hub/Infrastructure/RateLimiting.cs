using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Glimt.Hub.Infrastructure;

/// <summary>Policies: "auth" (10/min per IP) for login, register, forgot; "api" (300/min per user or IP) for the rest; "errors" (20/min per IP) for POST /api/client-errors.</summary>
public static class RateLimiting
{
    public const string AuthPolicy = "auth";
    public const string ApiPolicy = "api";
    public const string ErrorsPolicy = "errors";

    public static IServiceCollection AddGlimtRateLimiting(this IServiceCollection services, GlimtOptions options)
    {
        services.AddRateLimiter(limiter =>
        {
            limiter.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            limiter.AddPolicy(AuthPolicy, context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = options.IsDevelopmentLike ? 1000 : 10, Window = TimeSpan.FromMinutes(1) }));
            limiter.AddPolicy(ApiPolicy, context => RateLimitPartition.GetFixedWindowLimiter(
                context.User.Identity?.IsAuthenticated == true ? context.User.Identity.Name ?? "user" : context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = options.IsDevelopmentLike ? 10000 : 300, Window = TimeSpan.FromMinutes(1) }));
            limiter.AddPolicy(ErrorsPolicy, context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = 20, Window = TimeSpan.FromMinutes(1) }));
        });
        return services;
    }
}
