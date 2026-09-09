using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Agents;

/// <summary>
/// Every 10 s: servers that are disconnected and not seen within GLIMT_DOWN_AFTER_SECONDS go from up
/// to down and the change is broadcast. Every minute lastSeenAt of connected servers is persisted so
/// "last seen" survives a hub restart (IMPLEMENTERINGSPLAN 2.5).
/// </summary>
internal sealed class DownDetector(
    AgentRegistry registry,
    IServerStatusPublisher publisher,
    IServerStore store,
    GlimtOptions options,
    TimeProvider clock,
    ILogger<DownDetector> logger) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(10);
    private const int PersistEveryTicks = 6;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var tick = 0;
        try
        {
            using var timer = new PeriodicTimer(Interval, clock);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                tick++;
                await SweepAsync(persist: tick % PersistEveryTicks == 0, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
    }

    internal async Task SweepAsync(bool persist, CancellationToken cancellationToken)
    {
        var cutoff = clock.GetUtcNow() - options.DownAfter;
        foreach (var session in registry.All)
        {
            if (session.Connected)
            {
                if (persist)
                {
                    await store.TouchAsync(session.ServerId, session.LastSeenAt?.UtcDateTime, session.Status, cancellationToken);
                }

                continue;
            }

            if (session.Status == ServerStatuses.Down || session.LastSeenAt > cutoff)
            {
                continue;
            }

            if (!session.TrySetStatus(ServerStatuses.Down))
            {
                continue;
            }

            logger.LogInformation("server {ServerId} ({Hostname}) is down, last seen {LastSeenAt}", session.ServerId, session.Hostname, session.LastSeenAt);
            await publisher.PublishAsync(session, cancellationToken);
            await store.TouchAsync(session.ServerId, session.LastSeenAt?.UtcDateTime, session.Status, cancellationToken);
        }
    }
}
