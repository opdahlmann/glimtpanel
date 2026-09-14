using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Agents.Protocol;

namespace Glimt.Hub.Features.Alerts;

/// <summary>Fired, resolved or reminder for one alert. `Quiet` = the server was silenced, muted or paused: shown, not sent.</summary>
public sealed record AlertEvent(string Kind, AlertDocument Alert, string ServerName, string? OwnerId, string OwnerTimezone, bool Quiet);

/// <summary>Where the engine's events go: the Live feature (SignalR `Alert`) and the notification dispatcher (push, e-mail, webhook).</summary>
public interface IAlertSink
{
    Task OnAlertAsync(AlertEvent alertEvent, CancellationToken cancellationToken);
}

/// <summary>
/// The alert engine (IMPLEMENTERINGSPLAN 4.6, step 7.1). State per (server, rule, instance): ok → pending (condition
/// true, duration not reached) → firing → ok. Snapshot rules are evaluated on every snapshot; server_down and the
/// 24-hour reminders on a 10 s sweep. Silence, mute and disabled rules come from <see cref="AlertConfigProvider"/>.
/// Persists through <see cref="IAlertStore"/> and tells the sinks; everything else is process memory, rebuilt from the
/// `firing` documents at startup (<see cref="AlertEngineService"/>).
/// </summary>
public sealed class AlertEngine(
    IAlertStore store,
    AlertConfigProvider config,
    ActiveAlertCounts counts,
    AgentRegistry registry,
    IEnumerable<IAlertSink> sinks,
    NodeLinker linker,
    TimeProvider clock,
    ILogger<AlertEngine> logger)
{
    public static readonly TimeSpan ReminderAfter = TimeSpan.FromHours(24);

    private enum Status
    {
        Ok,
        Pending,
        Firing,
    }

    private sealed class RuleState
    {
        public Status Status;
        public DateTimeOffset? PendingSince;
        public AlertDocument? Alert;
    }

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<(string ServerId, string Rule, string Key), RuleState> _states = [];
    private readonly Dictionary<string, ContainerTracker> _containers = new(StringComparer.Ordinal);
    private readonly IReadOnlyList<IAlertSink> _sinks = sinks.ToList();

    /// <summary>Rebuilds the in-memory state from the alerts that were firing when the hub stopped.</summary>
    public async Task RestoreAsync(IEnumerable<AlertDocument> firing, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            foreach (var alert in firing)
            {
                _states[(alert.ServerId, alert.Rule, alert.Key)] = new RuleState { Status = Status.Firing, Alert = alert };
            }

            foreach (var serverId in firing.Select(a => a.ServerId).Distinct())
            {
                Recount(serverId);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Evaluates the snapshot rules; called by AgentIngest after the buffer is updated.</summary>
    public async Task SnapshotAsync(AgentSession session, Snapshot snapshot, CancellationToken cancellationToken)
    {
        var serverConfig = await config.GetAsync(session, cancellationToken);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var now = clock.GetUtcNow();
            if (!_containers.TryGetValue(session.ServerId, out var tracker))
            {
                tracker = new ContainerTracker();
                _containers[session.ServerId] = tracker;
            }

            var node = session.IsContainer ? NodeContext.For(session, now, linker.LinkOf(session.ServerId)) : null;
            var observed = RuleEvaluator.Evaluate(snapshot, serverConfig, tracker, now, node);
            var trueKeys = observed.ToDictionary(o => (o.Rule, o.Key), o => o.Detail);

            foreach (var definition in AlertRules.All)
            {
                if (definition.Id == AlertRuleIds.ServerDown || (session.IsContainer && AlertRules.ServerOnly(definition.Id)))
                {
                    continue;
                }

                var rule = serverConfig.Rule(definition.Id);
                foreach (var (key, detail) in trueKeys.Where(kv => kv.Key.Rule == definition.Id).Select(kv => (kv.Key.Key, kv.Value)))
                {
                    await ObserveTrueAsync(session, serverConfig, rule, key, detail, now, cancellationToken);
                }

                foreach (var stateKey in _states.Keys.Where(k => k.ServerId == session.ServerId && k.Rule == definition.Id && !trueKeys.ContainsKey((k.Rule, k.Key))).ToList())
                {
                    await ObserveFalseAsync(session, serverConfig, stateKey.Key, definition.Id, now, notify: rule.Enabled, cancellationToken);
                }
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>server_down for every known server, and the daily reminders. Runs every 10 s and after POST /api/e2e/advance.</summary>
    public async Task SweepAsync(CancellationToken cancellationToken)
    {
        foreach (var session in registry.All)
        {
            ServerAlertConfig serverConfig;
            try
            {
                serverConfig = await config.GetAsync(session, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogDebug("alert config for {ServerId} failed: {Error}", session.ServerId, ex.Message);
                continue;
            }

            await _gate.WaitAsync(cancellationToken);
            try
            {
                var now = clock.GetUtcNow();
                var rule = serverConfig.Rule(AlertRuleIds.ServerDown);
                // A sleeping node stopped on purpose (bye): no server_down until it is back and then gone for real.
                var down = rule.Enabled
                    && !session.Connected
                    && session.Status is not (ServerStatuses.Paused or ServerStatuses.Sleeping)
                    && session.LastSeenAt is { } seen
                    && now - seen >= TimeSpan.FromSeconds(rule.DurationSec ?? 120);
                if (down)
                {
                    var detail = RuleEvaluator.ServerDownDetail(session.LastSeenAt!.Value, serverConfig.Timezone);
                    await ObserveTrueAsync(session, serverConfig, rule, "", detail, now, cancellationToken);
                }
                else if (_states.ContainsKey((session.ServerId, AlertRuleIds.ServerDown, "")))
                {
                    await ObserveFalseAsync(session, serverConfig, "", AlertRuleIds.ServerDown, now, notify: rule.Enabled, cancellationToken);
                }

                await RemindAsync(session, serverConfig, now, cancellationToken);
            }
            finally
            {
                _gate.Release();
            }
        }
    }

    /// <summary>The agent is back: a firing server_down is resolved at once instead of at the next sweep.</summary>
    public async Task ServerUpAsync(AgentSession session, CancellationToken cancellationToken)
    {
        if (!session.Connected)
        {
            return;
        }

        var serverConfig = await config.GetAsync(session, cancellationToken);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_states.ContainsKey((session.ServerId, AlertRuleIds.ServerDown, "")))
            {
                await ObserveFalseAsync(session, serverConfig, "", AlertRuleIds.ServerDown, clock.GetUtcNow(), notify: true, cancellationToken);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The server (or its owner) was removed: drop its state and counts.</summary>
    public async Task ForgetAsync(string serverId, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            foreach (var key in _states.Keys.Where(k => k.ServerId == serverId).ToList())
            {
                _states.Remove(key);
            }

            _containers.Remove(serverId);
            counts.Remove(serverId);
        }
        finally
        {
            _gate.Release();
        }

        config.Invalidate(serverId);
    }

    /// <summary>Firing alerts as the engine sees them (tests and the e2e endpoint).</summary>
    public IReadOnlyList<AlertDocument> Firing(string? serverId = null)
    {
        _gate.Wait();
        try
        {
            return _states.Where(kv => kv.Value.Status == Status.Firing && (serverId is null || kv.Key.ServerId == serverId)).Select(kv => kv.Value.Alert!).ToList();
        }
        finally
        {
            _gate.Release();
        }
    }

    // ---- transitions (called with the gate held) ------------------------------------------------

    private async Task ObserveTrueAsync(AgentSession session, ServerAlertConfig serverConfig, EffectiveRule rule, string key, string detail, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var stateKey = (session.ServerId, rule.Id, key);
        if (!_states.TryGetValue(stateKey, out var state))
        {
            state = new RuleState();
            _states[stateKey] = state;
        }

        // A window (server_down, cont_restart) is applied by the evaluator; only a hold delays the fire.
        var hold = rule.Definition.DurationIsWindow ? 0 : rule.DurationSec ?? 0;
        switch (state.Status)
        {
            case Status.Firing:
                return;
            case Status.Ok when hold > 0:
                state.Status = Status.Pending;
                state.PendingSince = now;
                return;
            case Status.Pending when now - state.PendingSince!.Value < TimeSpan.FromSeconds(hold):
                return;
        }

        var alert = new AlertDocument
        {
            ServerId = session.ServerId,
            OwnerId = serverConfig.OwnerId,
            Rule = rule.Id,
            Key = key,
            Severity = rule.Severity,
            State = AlertStates.Firing,
            Detail = detail,
            FiredAt = now.UtcDateTime,
        };
        state.Status = Status.Firing;
        state.PendingSince = null;
        state.Alert = alert;
        Recount(session.ServerId);
        await store.InsertAsync(alert, cancellationToken);
        logger.LogInformation("alert fired: {Server} {Rule} {Detail}", session.Name, rule.Id, detail);
        await EmitAsync(new AlertEvent(AlertEventKinds.Fired, alert, session.Name, serverConfig.OwnerId, serverConfig.Timezone, serverConfig.IsQuiet(now)), cancellationToken);
    }

    private async Task ObserveFalseAsync(AgentSession session, ServerAlertConfig serverConfig, string key, string ruleId, DateTimeOffset now, bool notify, CancellationToken cancellationToken)
    {
        var stateKey = (session.ServerId, ruleId, key);
        if (!_states.Remove(stateKey, out var state) || state.Status != Status.Firing || state.Alert is null)
        {
            return;
        }

        var alert = state.Alert;
        alert.State = AlertStates.Resolved;
        alert.ResolvedAt = now.UtcDateTime;
        Recount(session.ServerId);
        await store.ResolveAsync(alert.Id, alert.ResolvedAt.Value, cancellationToken);
        logger.LogInformation("alert resolved: {Server} {Rule} {Detail}", session.Name, ruleId, alert.Detail);
        await EmitAsync(new AlertEvent(AlertEventKinds.Resolved, alert, session.Name, serverConfig.OwnerId, serverConfig.Timezone, !notify || serverConfig.IsQuiet(now)), cancellationToken);
    }

    private async Task RemindAsync(AgentSession session, ServerAlertConfig serverConfig, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (serverConfig.IsQuiet(now))
        {
            return;
        }

        foreach (var (key, state) in _states.Where(kv => kv.Key.ServerId == session.ServerId && kv.Value.Status == Status.Firing).ToList())
        {
            var alert = state.Alert!;
            if (alert.Severity == AlertSeverities.Info)
            {
                continue;
            }

            var last = Utc(alert.LastReminderAt ?? alert.FiredAt);
            if (now - last < ReminderAfter)
            {
                continue;
            }

            alert.LastReminderAt = now.UtcDateTime;
            await store.SetReminderAsync(alert.Id, alert.LastReminderAt.Value, cancellationToken);
            logger.LogInformation("alert reminder: {Server} {Rule}", session.Name, key.Rule);
            await EmitAsync(new AlertEvent(AlertEventKinds.Reminder, alert, session.Name, serverConfig.OwnerId, serverConfig.Timezone, false), cancellationToken);
        }
    }

    private void Recount(string serverId)
    {
        var firing = _states.Where(kv => kv.Key.ServerId == serverId && kv.Value.Status == Status.Firing).Select(kv => kv.Value.Alert!).ToList();
        var worst = firing.Count == 0 ? null : firing.MaxBy(a => AlertSeverities.Rank(a.Severity))!.Severity;
        counts.Set(serverId, new AlertSummary(firing.Count, worst));
    }

    private async Task EmitAsync(AlertEvent alertEvent, CancellationToken cancellationToken)
    {
        foreach (var sink in _sinks)
        {
            try
            {
                await sink.OnAlertAsync(alertEvent, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("alert sink {Sink} failed for {Rule} on {Server}: {Error}", sink.GetType().Name, alertEvent.Alert.Rule, alertEvent.Alert.ServerId, ex.Message);
            }
        }
    }

    private static DateTimeOffset Utc(DateTime value) => new(DateTime.SpecifyKind(value, DateTimeKind.Utc));
}

/// <summary>Restores firing alerts once MongoDB answers, then runs the engine's sweep every 10 s.</summary>
public sealed class AlertEngineService(AlertEngine engine, IAlertStore store, Infrastructure.MongoContext mongo, TimeProvider clock, ILogger<AlertEngineService> logger) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan MongoWait = TimeSpan.FromSeconds(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            try
            {
                if (await mongo.Ready.WaitAsync(MongoWait, stoppingToken))
                {
                    var firing = await store.ListFiringAsync(stoppingToken);
                    await engine.RestoreAsync(firing, stoppingToken);
                    if (firing.Count > 0)
                    {
                        logger.LogInformation("restored {Count} firing alerts", firing.Count);
                    }
                }
            }
            catch (TimeoutException)
            {
                logger.LogDebug("alerts: MongoDB not ready within {Seconds} s; starting without restored state", MongoWait.TotalSeconds);
            }

            using var timer = new PeriodicTimer(Interval, clock);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try
                {
                    await engine.SweepAsync(stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning("alert sweep failed: {Error}", ex.Message);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
    }
}
