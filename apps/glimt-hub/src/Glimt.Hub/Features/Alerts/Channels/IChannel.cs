using Glimt.Hub.Features.Servers;

namespace Glimt.Hub.Features.Alerts.Channels;

public static class ChannelNames
{
    public const string Push = "push";
    public const string Email = "email";
    public const string Webhook = "webhook";
}

/// <summary>One alert event addressed to one user, with that user's channel settings.</summary>
public sealed record AlertNotification(AlertEvent Event, UserDocument User, AlertSettingsDocument Settings, bool IsOwner);

/// <summary>A delivery channel (push, e-mail, webhook). Never throws into the engine; returns whether at least one message went out.</summary>
public interface IChannel
{
    string Name { get; }

    Task<bool> SendAsync(AlertNotification notification, CancellationToken cancellationToken);
}
