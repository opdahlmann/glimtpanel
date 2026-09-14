using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Alerts;

/// <summary>
/// Persistence for alerts, alert settings and push subscriptions. Like the server store every call is a no-op
/// (null/empty/false) without MongoDB, so the engine keeps evaluating in memory when the database is away.
/// </summary>
public interface IAlertStore
{
    // ---- alerts ----------------------------------------------------------------------------------
    Task InsertAsync(AlertDocument alert, CancellationToken cancellationToken);

    Task ResolveAsync(string alertId, DateTime resolvedAt, CancellationToken cancellationToken);

    Task SetReminderAsync(string alertId, DateTime at, CancellationToken cancellationToken);

    Task AddNotifiedViaAsync(string alertId, string channel, CancellationToken cancellationToken);

    /// <summary>Every alert still firing, for the rebuild after a hub restart.</summary>
    Task<IReadOnlyList<AlertDocument>> ListFiringAsync(CancellationToken cancellationToken);

    /// <summary>Newest first, at most <paramref name="limit"/>; state = firing, resolved or null for all.</summary>
    Task<IReadOnlyList<AlertDocument>> ListByServersAsync(IReadOnlyCollection<string> serverIds, string? state, int limit, CancellationToken cancellationToken);

    /// <summary>Alerts fired since <paramref name="since"/> on the given servers (the digest), oldest first.</summary>
    Task<IReadOnlyList<AlertDocument>> ListFiredSinceAsync(IReadOnlyCollection<string> serverIds, DateTime since, CancellationToken cancellationToken);

    Task DeleteByServerAsync(string serverId, CancellationToken cancellationToken);

    // ---- settings --------------------------------------------------------------------------------
    Task<AlertSettingsDocument?> GetSettingsAsync(string userId, CancellationToken cancellationToken);

    /// <summary>Inserts or replaces the user's settings document (matched on userId).</summary>
    Task UpsertSettingsAsync(AlertSettingsDocument settings, CancellationToken cancellationToken);

    Task<IReadOnlyList<AlertSettingsDocument>> ListSettingsAsync(CancellationToken cancellationToken);

    Task SetLastDigestDateAsync(string userId, string localDate, CancellationToken cancellationToken);

    // ---- push subscriptions ----------------------------------------------------------------------
    /// <summary>Upserts on endpoint (a re-subscribe from the same browser replaces the old keys).</summary>
    Task UpsertSubscriptionAsync(PushSubscriptionDocument subscription, CancellationToken cancellationToken);

    Task<bool> DeleteSubscriptionAsync(string userId, string endpoint, CancellationToken cancellationToken);

    /// <summary>Removes a subscription the push service reported as gone (404/410), whoever owns it.</summary>
    Task DeleteSubscriptionByEndpointAsync(string endpoint, CancellationToken cancellationToken);

    Task<IReadOnlyList<PushSubscriptionDocument>> ListSubscriptionsAsync(IReadOnlyCollection<string> userIds, CancellationToken cancellationToken);
}

internal sealed class MongoAlertStore(MongoContext mongo, ILogger<MongoAlertStore> logger) : IAlertStore
{
    private IMongoCollection<AlertDocument> Alerts => mongo.Db.GetCollection<AlertDocument>(AlertDocument.Collection);
    private IMongoCollection<AlertSettingsDocument> Settings => mongo.Db.GetCollection<AlertSettingsDocument>(AlertSettingsDocument.Collection);
    private IMongoCollection<PushSubscriptionDocument> Subscriptions => mongo.Db.GetCollection<PushSubscriptionDocument>(PushSubscriptionDocument.Collection);

    public Task InsertAsync(AlertDocument alert, CancellationToken cancellationToken) =>
        Guarded(() => Alerts.InsertOneAsync(alert, cancellationToken: cancellationToken), "insert alert");

    public Task ResolveAsync(string alertId, DateTime resolvedAt, CancellationToken cancellationToken) =>
        Guarded(() => Alerts.UpdateOneAsync(
            a => a.Id == alertId,
            Builders<AlertDocument>.Update.Set(a => a.State, AlertStates.Resolved).Set(a => a.ResolvedAt, resolvedAt),
            cancellationToken: cancellationToken), "resolve alert");

    public Task SetReminderAsync(string alertId, DateTime at, CancellationToken cancellationToken) =>
        Guarded(() => Alerts.UpdateOneAsync(a => a.Id == alertId, Builders<AlertDocument>.Update.Set(a => a.LastReminderAt, at), cancellationToken: cancellationToken), "set reminder");

    public Task AddNotifiedViaAsync(string alertId, string channel, CancellationToken cancellationToken) =>
        Guarded(() => Alerts.UpdateOneAsync(a => a.Id == alertId, Builders<AlertDocument>.Update.AddToSet(a => a.NotifiedVia, channel), cancellationToken: cancellationToken), "add notifiedVia");

    public async Task<IReadOnlyList<AlertDocument>> ListFiringAsync(CancellationToken cancellationToken) =>
        mongo.IsAvailable ? await Alerts.Find(a => a.State == AlertStates.Firing).ToListAsync(cancellationToken) : [];

    public async Task<IReadOnlyList<AlertDocument>> ListByServersAsync(IReadOnlyCollection<string> serverIds, string? state, int limit, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable || serverIds.Count == 0)
        {
            return [];
        }

        var filter = Builders<AlertDocument>.Filter.In(a => a.ServerId, serverIds);
        if (state is AlertStates.Firing or AlertStates.Resolved)
        {
            filter &= Builders<AlertDocument>.Filter.Eq(a => a.State, state);
        }

        return await Alerts.Find(filter).SortByDescending(a => a.FiredAt).Limit(limit).ToListAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<AlertDocument>> ListFiredSinceAsync(IReadOnlyCollection<string> serverIds, DateTime since, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable || serverIds.Count == 0)
        {
            return [];
        }

        var filter = Builders<AlertDocument>.Filter.In(a => a.ServerId, serverIds) & Builders<AlertDocument>.Filter.Gte(a => a.FiredAt, since);
        return await Alerts.Find(filter).SortBy(a => a.FiredAt).ToListAsync(cancellationToken);
    }

    public Task DeleteByServerAsync(string serverId, CancellationToken cancellationToken) =>
        Guarded(() => Alerts.DeleteManyAsync(a => a.ServerId == serverId, cancellationToken), "delete alerts");

    public async Task<AlertSettingsDocument?> GetSettingsAsync(string userId, CancellationToken cancellationToken) =>
        mongo.IsAvailable ? await Settings.Find(s => s.UserId == userId).FirstOrDefaultAsync(cancellationToken) : null;

    public Task UpsertSettingsAsync(AlertSettingsDocument settings, CancellationToken cancellationToken) =>
        Guarded(() => Settings.ReplaceOneAsync(s => s.UserId == settings.UserId, settings, new ReplaceOptions { IsUpsert = true }, cancellationToken), "save alert settings");

    public async Task<IReadOnlyList<AlertSettingsDocument>> ListSettingsAsync(CancellationToken cancellationToken) =>
        mongo.IsAvailable ? await Settings.Find(FilterDefinition<AlertSettingsDocument>.Empty).ToListAsync(cancellationToken) : [];

    public Task SetLastDigestDateAsync(string userId, string localDate, CancellationToken cancellationToken) =>
        Guarded(() => Settings.UpdateOneAsync(
            s => s.UserId == userId,
            Builders<AlertSettingsDocument>.Update.Set(s => s.LastDigestDate, localDate).SetOnInsert(s => s.Id, Guid.NewGuid().ToString("N")),
            new UpdateOptions { IsUpsert = true },
            cancellationToken), "set last digest");

    public Task UpsertSubscriptionAsync(PushSubscriptionDocument subscription, CancellationToken cancellationToken) =>
        Guarded(() => Subscriptions.UpdateOneAsync(
            s => s.Endpoint == subscription.Endpoint,
            Builders<PushSubscriptionDocument>.Update
                .Set(s => s.UserId, subscription.UserId)
                .Set(s => s.P256dh, subscription.P256dh)
                .Set(s => s.Auth, subscription.Auth)
                .Set(s => s.Device, subscription.Device)
                .Set(s => s.FailedAt, null)
                .SetOnInsert(s => s.Id, subscription.Id)
                .SetOnInsert(s => s.CreatedAt, subscription.CreatedAt),
            new UpdateOptions { IsUpsert = true },
            cancellationToken), "save push subscription");

    public async Task<bool> DeleteSubscriptionAsync(string userId, string endpoint, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable)
        {
            return false;
        }

        var result = await Subscriptions.DeleteOneAsync(s => s.UserId == userId && s.Endpoint == endpoint, cancellationToken);
        return result.DeletedCount > 0;
    }

    public Task DeleteSubscriptionByEndpointAsync(string endpoint, CancellationToken cancellationToken) =>
        Guarded(() => Subscriptions.DeleteManyAsync(s => s.Endpoint == endpoint, cancellationToken), "delete push subscription");

    public async Task<IReadOnlyList<PushSubscriptionDocument>> ListSubscriptionsAsync(IReadOnlyCollection<string> userIds, CancellationToken cancellationToken)
    {
        if (!mongo.IsAvailable || userIds.Count == 0)
        {
            return [];
        }

        return await Subscriptions.Find(Builders<PushSubscriptionDocument>.Filter.In(s => s.UserId, userIds)).ToListAsync(cancellationToken);
    }

    private async Task Guarded(Func<Task> action, string what)
    {
        if (!mongo.IsAvailable)
        {
            return;
        }

        try
        {
            await action();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("could not {What}: {Error}", what, ex.Message);
        }
    }
}
