using Glimt.Hub.Features.Alerts.Push;

namespace Glimt.Hub.Features.Alerts.Channels;

/// <summary>Web Push to every device the user has subscribed (IMPLEMENTERINGSPLAN step 7.2). Critical alerts are urgent.</summary>
public sealed class PushChannel(IWebPushClient client, IAlertStore store, ILogger<PushChannel> logger) : IChannel
{
    public string Name => ChannelNames.Push;

    public async Task<bool> SendAsync(AlertNotification notification, CancellationToken cancellationToken)
    {
        if (!client.IsConfigured)
        {
            return false;
        }

        var subscriptions = await store.ListSubscriptionsAsync([notification.User.Id], cancellationToken);
        if (subscriptions.Count == 0)
        {
            return false;
        }

        var e = notification.Event;
        var payload = new PushPayload(
            AlertTexts.Title(e, notification.User.Language),
            e.Alert.Detail.Length == 0 ? AlertTexts.RuleName(e.Alert.Rule, notification.User.Language) : e.Alert.Detail,
            AlertTexts.Path(e.Alert),
            AlertTexts.Tag(e.Alert));
        var urgent = e.Alert.Severity == AlertSeverities.Critical && e.Kind != AlertEventKinds.Resolved;
        var delivered = false;
        foreach (var subscription in subscriptions)
        {
            var outcome = await client.SendAsync(subscription, payload, urgent, AlertTexts.Topic(e.Alert), cancellationToken);
            delivered |= outcome == PushOutcome.Delivered;
            if (outcome is not (PushOutcome.Delivered or PushOutcome.Gone))
            {
                logger.LogDebug("push to {Device} of {User}: {Outcome}", subscription.Device, notification.User.Email, outcome);
            }
        }

        return delivered;
    }
}
