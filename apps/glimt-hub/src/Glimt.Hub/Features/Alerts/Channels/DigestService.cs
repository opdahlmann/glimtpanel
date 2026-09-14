using System.Globalization;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Access;
using Glimt.Hub.Infrastructure.Email;

namespace Glimt.Hub.Features.Alerts.Channels;

/// <summary>
/// The daily summary (FUNKSJONSBESKRIVELSE 10.4): every minute, users whose local time is their digest time (default
/// 08:00) get one e-mail with the info alerts of the last 24 hours and everything still firing on the servers they can
/// see. Nothing is sent when both lists are empty. Sent once per local date (`lastDigestDate`).
/// </summary>
public sealed class DigestService(
    IAlertStore store,
    UserStore users,
    IAccessService access,
    IServerStore servers,
    AgentRegistry registry,
    IEmailSender mail,
    AuthSessions sessions,
    MongoContext mongo,
    TimeProvider clock,
    ILogger<DigestService> logger) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            using var timer = new PeriodicTimer(Interval, clock);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                if (!mongo.IsAvailable)
                {
                    continue;
                }

                try
                {
                    await RunOnceAsync(stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning("digest run failed: {Error}", ex.Message);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
    }

    /// <summary>One pass over all users; returns how many digests were sent. Public for the tests.</summary>
    public async Task<int> RunOnceAsync(CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var settingsByUser = (await store.ListSettingsAsync(cancellationToken)).ToDictionary(s => s.UserId, StringComparer.Ordinal);
        var sent = 0;
        foreach (var user in await users.ListAsync(cancellationToken))
        {
            var settings = settingsByUser.GetValueOrDefault(user.Id) ?? AlertSettingsDocument.Defaults(user.Id);
            if (!settings.Digest.Enabled || !IsDue(settings, user.Timezone, now, out var localDate))
            {
                continue;
            }

            if (await SendAsync(user, now, cancellationToken))
            {
                sent++;
            }

            await store.SetLastDigestDateAsync(user.Id, localDate, cancellationToken);
        }

        return sent;
    }

    /// <summary>Due when the local clock reads the digest time (to the minute) and no digest went out on that local date.</summary>
    public static bool IsDue(AlertSettingsDocument settings, string? timezone, DateTimeOffset now, out string localDate)
    {
        var local = now;
        if (!string.IsNullOrWhiteSpace(timezone) && TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out var zone))
        {
            local = TimeZoneInfo.ConvertTime(now, zone);
        }

        localDate = local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        return local.ToString("HH:mm", CultureInfo.InvariantCulture) == settings.Digest.Time && settings.LastDigestDate != localDate;
    }

    private async Task<bool> SendAsync(UserDocument user, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var visible = await access.VisibleServerIdsAsync(user.Id, cancellationToken);
        if (visible.Count == 0)
        {
            return false;
        }

        var recent = await store.ListFiredSinceAsync(visible, (now - TimeSpan.FromHours(24)).UtcDateTime, cancellationToken);
        var info = recent.Where(a => a.Severity == AlertSeverities.Info).ToList();
        var firing = (await store.ListByServersAsync(visible, AlertStates.Firing, 200, cancellationToken)).Where(a => a.Severity != AlertSeverities.Info).ToList();
        if (info.Count == 0 && firing.Count == 0)
        {
            return false;
        }

        var names = await NamesAsync(info.Concat(firing).Select(a => a.ServerId).Distinct().ToList(), cancellationToken);
        var message = AlertEmailTemplates.Digest(
            user.Email,
            user.Language,
            user.Timezone,
            info.Select(a => (a, names.GetValueOrDefault(a.ServerId, a.ServerId))).ToList(),
            firing.Select(a => (a, names.GetValueOrDefault(a.ServerId, a.ServerId))).ToList(),
            sessions.WebLink("/alerts"));
        return await mail.SendAsync(message, cancellationToken);
    }

    private async Task<Dictionary<string, string>> NamesAsync(IReadOnlyList<string> serverIds, CancellationToken cancellationToken)
    {
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var doc in await servers.ListByIdsAsync(serverIds, cancellationToken))
        {
            names[doc.Id] = doc.Name;
        }

        foreach (var id in serverIds)
        {
            if (!names.ContainsKey(id) && registry.TryGet(id, out var session))
            {
                names[id] = session.Name;
            }
        }

        return names;
    }
}
