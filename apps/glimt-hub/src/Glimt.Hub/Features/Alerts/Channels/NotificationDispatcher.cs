using Glimt.Hub.Features.Auth;
using Glimt.Hub.Infrastructure.Access;

namespace Glimt.Hub.Features.Alerts.Channels;

/// <summary>
/// Turns engine events into deliveries (IMPLEMENTERINGSPLAN step 7.2). Recipients are everyone who can see the
/// server; push goes to each of them who has push on, e-mail and webhook only to the owner. Info alerts (reboot) are
/// not sent at all: they wait for the daily digest. Quiet events (silenced, muted, disabled) are shown but not sent.
/// </summary>
public sealed class NotificationDispatcher(
    IEnumerable<IChannel> channels,
    IAccessService access,
    IUserLookup users,
    IAlertStore store,
    ILogger<NotificationDispatcher> logger) : IAlertSink
{
    private readonly IReadOnlyList<IChannel> _channels = channels.ToList();

    public async Task OnAlertAsync(AlertEvent alertEvent, CancellationToken cancellationToken)
    {
        if (alertEvent.Quiet || alertEvent.Alert.Severity == AlertSeverities.Info)
        {
            return;
        }

        var userIds = await access.UserIdsWithAccessAsync(alertEvent.Alert.ServerId, cancellationToken);
        if (alertEvent.OwnerId is not null && !userIds.Contains(alertEvent.OwnerId))
        {
            userIds = [.. userIds, alertEvent.OwnerId];
        }

        foreach (var user in await users.FindByIdsAsync(userIds, cancellationToken))
        {
            var settings = await store.GetSettingsAsync(user.Id, cancellationToken) ?? AlertSettingsDocument.Defaults(user.Id);
            var notification = new AlertNotification(alertEvent, user, settings, user.Id == alertEvent.OwnerId);
            foreach (var channel in _channels)
            {
                if (!Wants(channel.Name, notification))
                {
                    continue;
                }

                try
                {
                    if (await channel.SendAsync(notification, cancellationToken) && alertEvent.Kind == AlertEventKinds.Fired)
                    {
                        await store.AddNotifiedViaAsync(alertEvent.Alert.Id, channel.Name, cancellationToken);
                        if (!alertEvent.Alert.NotifiedVia.Contains(channel.Name))
                        {
                            alertEvent.Alert.NotifiedVia.Add(channel.Name);
                        }
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning("{Channel} to {User} failed for {Rule} on {Server}: {Error}", channel.Name, user.Email, alertEvent.Alert.Rule, alertEvent.ServerName, ex.Message);
                }
            }
        }
    }

    /// <summary>The channel rules from FUNKSJONSBESKRIVELSE 10.3, as one predicate (tested with a fake channel).</summary>
    public static bool Wants(string channel, AlertNotification n) => channel switch
    {
        ChannelNames.Push => n.Settings.Channels.Push,
        ChannelNames.Email => n.IsOwner && (AlertRules.AlwaysEmailed(n.Event.Alert.Rule) || n.Settings.Channels.Email),
        ChannelNames.Webhook => n.IsOwner && !string.IsNullOrWhiteSpace(n.Settings.Channels.WebhookUrl),
        _ => false,
    };
}
