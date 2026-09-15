using Glimt.Hub.Features.Auth;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Auth;

namespace Glimt.Hub.Features.Demo;

/// <summary>
/// The demo account (step 10.1) may look, never change: every non-GET request under /api with a demo token is
/// answered 403 before it reaches an endpoint. That covers account changes, invites, alert settings, push
/// subscriptions, groups, node tokens and deletion in one place; the anonymous endpoints (POST /api/demo/session,
/// /api/auth/*, /api/client-errors, SignalR negotiate) carry no demo identity and pass. Only active in demo mode.
/// </summary>
public static class DemoReadOnly
{
    public const string Title = "The demo account is read-only";
    public const string Code = "demo-read-only";

    public static bool IsDemoAccount(HttpContext http) =>
        string.Equals(http.User.GetEmail(), DemoData.DemoUserEmail, StringComparison.OrdinalIgnoreCase);

    public static bool IsWrite(HttpContext http) =>
        !HttpMethods.IsGet(http.Request.Method) && !HttpMethods.IsHead(http.Request.Method) && !HttpMethods.IsOptions(http.Request.Method);

    public static IApplicationBuilder UseDemoReadOnly(this IApplicationBuilder app, GlimtOptions options)
    {
        if (!DemoFeature.IsDemoMode(options))
        {
            return app;
        }

        return app.Use(async (http, next) =>
        {
            if (http.Request.Path.StartsWithSegments("/api") && IsWrite(http) && http.User.Identity?.IsAuthenticated == true && IsDemoAccount(http))
            {
                await Validation.Forbidden(Title, Code).ExecuteAsync(http);
                return;
            }

            await next(http);
        });
    }
}
