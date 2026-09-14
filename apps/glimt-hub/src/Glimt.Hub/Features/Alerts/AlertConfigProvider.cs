using System.Collections.Concurrent;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Servers;

namespace Glimt.Hub.Features.Alerts;

/// <summary>Everything the engine needs to know about one server: who owns it, whether it is muted or silenced, and the effective rules.</summary>
public sealed record ServerAlertConfig(
    string? OwnerId,
    string Timezone,
    bool Muted,
    DateTimeOffset? SilencedUntil,
    IReadOnlyDictionary<string, EffectiveRule> Rules)
{
    public EffectiveRule Rule(string id) => Rules[id];

    /// <summary>Silenced or muted: the state machine keeps running, nobody is told (IMPLEMENTERINGSPLAN 4.6).</summary>
    public bool IsQuiet(DateTimeOffset now) => Muted || SilencedUntil is { } until && until > now;

    public static IReadOnlyDictionary<string, EffectiveRule> Resolve(AlertSettingsDocument? account, IReadOnlyDictionary<string, RuleSettingDocument>? overrides)
    {
        var rules = new Dictionary<string, EffectiveRule>(StringComparer.Ordinal);
        foreach (var definition in AlertRules.All)
        {
            var rule = EffectiveRule.Default(definition);
            if (account is not null && account.Rules.TryGetValue(definition.Id, out var setting))
            {
                rule = rule.With(setting);
            }

            if (overrides is not null && overrides.TryGetValue(definition.Id, out var over))
            {
                rule = rule.With(over);
            }

            rules[definition.Id] = rule;
        }

        return rules;
    }
}

/// <summary>
/// Resolves and caches the alert configuration per server: the owner's `alertSettings.rules` laid over the defaults,
/// then the server's `alertOverrides`, plus mute and silence (step 7.1). Cached for a minute; the endpoints that change
/// settings call <see cref="Invalidate"/> / <see cref="InvalidateOwner"/>. Without MongoDB everything is defaults,
/// and ownerless servers belong to the dev user outside production.
/// </summary>
public sealed class AlertConfigProvider(
    IServerStore servers,
    IAlertStore alerts,
    IUserLookup users,
    UserDirectory directory,
    TimeProvider clock,
    ILogger<AlertConfigProvider> logger)
{
    public static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(1);

    private readonly ConcurrentDictionary<string, (ServerAlertConfig Config, DateTimeOffset At)> _cache = new(StringComparer.Ordinal);

    public async Task<ServerAlertConfig> GetAsync(AgentSession session, CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        if (_cache.TryGetValue(session.ServerId, out var hit) && now - hit.At < CacheFor)
        {
            return hit.Config;
        }

        var config = await LoadAsync(session, cancellationToken);
        _cache[session.ServerId] = (config, now);
        return config;
    }

    public void Invalidate(string serverId) => _cache.TryRemove(serverId, out _);

    public void InvalidateOwner(string ownerId)
    {
        foreach (var (serverId, entry) in _cache)
        {
            if (entry.Config.OwnerId == ownerId)
            {
                _cache.TryRemove(serverId, out _);
            }
        }
    }

    public void Clear() => _cache.Clear();

    private async Task<ServerAlertConfig> LoadAsync(AgentSession session, CancellationToken cancellationToken)
    {
        var doc = await servers.FindAsync(session.ServerId, cancellationToken);
        var ownerId = doc?.OwnerId ?? session.OwnerId ?? await directory.DevUserIdAsync(cancellationToken);
        AlertSettingsDocument? settings = null;
        var timezone = "UTC";
        if (ownerId is not null)
        {
            // Without MongoDB the lookups throw; the rules then run with defaults, which is what the walking skeleton needs.
            try
            {
                settings = await alerts.GetSettingsAsync(ownerId, cancellationToken);
                if ((await users.FindByIdsAsync([ownerId], cancellationToken)).FirstOrDefault() is { } owner && !string.IsNullOrWhiteSpace(owner.Timezone))
                {
                    timezone = owner.Timezone;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogDebug("alert settings for owner {OwnerId} unavailable, using defaults: {Error}", ownerId, ex.Message);
            }
        }

        return new ServerAlertConfig(
            ownerId,
            timezone,
            doc?.AlertsMuted ?? false,
            doc?.SilencedUntil is { } until ? new DateTimeOffset(DateTime.SpecifyKind(until, DateTimeKind.Utc)) : null,
            ServerAlertConfig.Resolve(settings, doc?.AlertOverrides));
    }
}
