using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Alerts;

namespace Glimt.Hub.Features.Live;

/// <summary>Engine events → `Alert(event)` to everyone who can see the server, followed by a fresh Card (activeAlerts changed).</summary>
internal sealed class LiveAlertSink(LivePublisher publisher, AgentRegistry registry, ActiveAlertCounts counts) : IAlertSink
{
    public async Task OnAlertAsync(AlertEvent alertEvent, CancellationToken cancellationToken)
    {
        var summary = counts.Get(alertEvent.Alert.ServerId);
        var dto = new AlertEventDto(
            alertEvent.Kind,
            AlertDto.From(alertEvent.Alert, alertEvent.ServerName, alertEvent.Quiet && alertEvent.Alert.State == AlertStates.Firing),
            summary.Count,
            summary.WorstSeverity);
        await publisher.AlertAsync(dto, alertEvent.OwnerId, cancellationToken);
        if (registry.TryGet(alertEvent.Alert.ServerId, out var session))
        {
            await publisher.CardAsync(session, cancellationToken);
        }
    }
}
