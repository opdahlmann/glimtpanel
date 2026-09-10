using Glimt.Hub.Features.Agents;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Auth;

namespace Glimt.Hub.Features.Demo;

public sealed record DemoSessionResponse(string AccessToken, string ExpiresAt, DemoUserResponse User);

public sealed record DemoUserResponse(string Id, string Email, string Name);

public sealed record DevTokenRequest(string Email);

/// <summary>Body of POST /api/e2e/{action}; every field is optional and only some apply to each action.</summary>
public sealed record E2eRequest(
    string? ServerId,
    int? Seconds,
    string? Unit,
    string? Key = null,
    string? Hostname = null,
    string? Email = null,
    string? Password = null,
    string? ReaderOf = null);

/// <summary>
/// GLIMT_DEMO_MODE=true or GLIMT_ENV=e2e: the fake agents and POST /api/demo/session. In development and
/// e2e also POST /api/dev/token (a JWT for any existing user, for scripts and manual testing). In e2e the
/// clock is shiftable and POST /api/e2e/* drives the fake servers, enrols a fake agent with a real one-time
/// key and creates test accounts (owner without servers, reader of the demo servers).
/// </summary>
public static class DemoFeature
{
    public static readonly TimeSpan DemoTokenLifetime = TimeSpan.FromHours(1);

    public static bool IsDemoMode(GlimtOptions options) => options.DemoMode || options.Env == GlimtOptions.E2e;

    public static IServiceCollection AddDemoFeature(this IServiceCollection services, GlimtOptions options)
    {
        if (options.Env == GlimtOptions.E2e)
        {
            // Registered after infrastructure, so this TimeProvider wins for every consumer.
            services.AddSingleton<ShiftableTimeProvider>();
            services.AddSingleton<TimeProvider>(sp => sp.GetRequiredService<ShiftableTimeProvider>());
        }

        if (IsDemoMode(options))
        {
            services.AddSingleton<FakeAgentService>();
            services.AddHostedService(sp => sp.GetRequiredService<FakeAgentService>());
        }

        if (options.Env == GlimtOptions.E2e)
        {
            services.AddSingleton<E2eUsers>();
        }

        return services;
    }

    public static IEndpointRouteBuilder MapDemoFeature(this IEndpointRouteBuilder app)
    {
        var options = app.ServiceProvider.GetRequiredService<GlimtOptions>();
        if (IsDemoMode(options))
        {
            app.MapPost("/api/demo/session", (FakeAgentService demo, JwtTokens tokens, TimeProvider clock) =>
                Results.Ok(Session(tokens, clock, demo.DemoUserId, DemoData.DemoUserEmail, "Demo")))
                .RequireRateLimiting(RateLimiting.AuthPolicy);
        }

        if (options.IsDevelopmentLike)
        {
            app.MapPost("/api/dev/token", async (DevTokenRequest request, UserDirectory users, JwtTokens tokens, TimeProvider clock, CancellationToken ct) =>
            {
                if (string.IsNullOrWhiteSpace(request?.Email))
                {
                    return Results.BadRequest(new { error = "email is required" });
                }

                var id = await users.FindIdByEmailAsync(request.Email, ct);
                return id is null
                    ? Results.NotFound(new { error = "no such user (is MongoDB available and the user seeded?)" })
                    : Results.Ok(Session(tokens, clock, id, request.Email.Trim().ToLowerInvariant(), "Developer"));
            }).RequireRateLimiting(RateLimiting.AuthPolicy);
        }

        if (options.Env == GlimtOptions.E2e && IsDemoMode(options))
        {
            app.MapPost("/api/e2e/{action}", async (string action, E2eRequest? request, FakeAgentService demo, E2eUsers e2eUsers, ShiftableTimeProvider clock, DownDetector down, CancellationToken ct) =>
            {
                request ??= new E2eRequest(null, null, null);
                switch (action)
                {
                    case "enrol-fake-agent":
                        var enrolled = await demo.EnrolAsync(request.Key, request.Hostname, ct);
                        return enrolled.Error is null
                            ? Results.Ok(new { ok = true, serverId = enrolled.ServerId, name = enrolled.Name, ownerId = enrolled.OwnerId })
                            : Results.Json(new { error = enrolled.Error }, statusCode: enrolled.Status);
                    case "ensure-user":
                        var ensured = await e2eUsers.EnsureAsync(request.Email, request.Password, request.ReaderOf, ct);
                        return ensured.Error is null
                            ? Results.Ok(new { ok = true, id = ensured.Id, email = ensured.Email, created = ensured.Created, reader = ensured.Reader })
                            : Results.Json(new { error = ensured.Error }, statusCode: ensured.Status);
                    case "disconnect-server":
                        return await demo.DisconnectAsync(request.ServerId, ct) ? Results.Ok(new { ok = true }) : Results.NotFound();
                    case "reconnect-server":
                        return await demo.ReconnectAsync(request.ServerId, ct) ? Results.Ok(new { ok = true }) : Results.NotFound();
                    case "fail-service":
                        return await demo.FailServiceAsync(request.ServerId, request.Unit, ct) ? Results.Ok(new { ok = true }) : Results.NotFound();
                    case "advance":
                        clock.Advance(TimeSpan.FromSeconds(request.Seconds is > 0 ? request.Seconds.Value : 60));
                        await down.SweepAsync(persist: false, ct);
                        return Results.Ok(new { ok = true, now = clock.GetUtcNow().ToString("o"), offsetSec = (long)clock.Offset.TotalSeconds });
                    default:
                        return Results.NotFound(new { error = "unknown e2e action; use disconnect-server, reconnect-server, fail-service, advance, enrol-fake-agent or ensure-user" });
                }
            });
        }

        return app;
    }

    private static DemoSessionResponse Session(JwtTokens tokens, TimeProvider clock, string userId, string email, string name) => new(
        tokens.IssueAccessToken(userId, email, name, "en", DemoTokenLifetime),
        (clock.GetUtcNow() + DemoTokenLifetime).UtcDateTime.ToString("o"),
        new DemoUserResponse(userId, email, name));
}
