using System.Text.Json.Nodes;
using Glimt.Hub.Features.Access;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Groups;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using MongoDB.Bson;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Account;

/// <summary>
/// Builds GET /api/account/export and runs the DELETE /api/account cascade. Collections that later features own
/// (alertSettings, alerts, pushSubscriptions) are read and deleted as raw documents so nothing breaks before they exist.
/// </summary>
public sealed class AccountExport(MongoContext mongo, IServerStore servers, AccessGrantStore grants, GroupStore groups, TimeProvider clock)
{
    public const string AlertSettingsCollection = "alertSettings";
    public const string AlertsCollection = "alerts";
    public const string PushSubscriptionsCollection = "pushSubscriptions";

    public async Task<JsonObject> BuildAsync(UserDocument user, CancellationToken cancellationToken)
    {
        var owned = await servers.ListByOwnersAsync([user.Id], cancellationToken);
        var given = await grants.ListByOwnerAsync(user.Id, cancellationToken);
        var received = await grants.ListReceivedAsync(user.Id, cancellationToken);
        var ownedGroups = await groups.ListByOwnerAsync(user.Id, cancellationToken);

        var alertSettings = await RawAsync(AlertSettingsCollection, new BsonDocument("userId", user.Id), cancellationToken);
        var alerts = await RawAsync(AlertsCollection, new BsonDocument("ownerId", user.Id), cancellationToken);
        var pushSubscriptions = await RawAsync(PushSubscriptionsCollection, new BsonDocument("userId", user.Id), cancellationToken, "endpoint", "device", "createdAt");

        return new JsonObject
        {
            ["exportedAt"] = clock.GetUtcNow().ToString("O"),
            ["user"] = new JsonObject
            {
                ["id"] = user.Id,
                ["email"] = user.Email,
                ["name"] = user.Name,
                ["timezone"] = user.Timezone,
                ["language"] = user.Language,
                ["plan"] = user.Plan,
                ["slots"] = new JsonObject { ["free"] = user.Slots.Free, ["paid"] = user.Slots.Paid },
                ["earlyAdopter"] = user.EarlyAdopter,
                ["emailConfirmedAt"] = Date(user.EmailConfirmedAt),
                ["createdAt"] = Date(user.CreatedAt),
            },
            ["servers"] = new JsonArray(owned.Select(Server).ToArray()),
            ["accessGrants"] = new JsonObject
            {
                ["given"] = new JsonArray(given.Select(Grant).ToArray()),
                ["received"] = new JsonArray(received.Select(Grant).ToArray()),
            },
            ["groups"] = new JsonArray(ownedGroups.Select(g => (JsonNode?)new JsonObject
            {
                ["id"] = g.Id,
                ["name"] = g.Name,
                ["memberIds"] = new JsonArray(g.MemberIds.Select(m => (JsonNode?)m).ToArray()),
                ["order"] = g.Order,
                ["createdAt"] = Date(g.CreatedAt),
            }).ToArray()),
            ["alertSettings"] = alertSettings.Count == 0 ? null : alertSettings[0],
            ["alerts"] = new JsonArray(alerts.ToArray<JsonNode?>()),
            ["pushSubscriptions"] = new JsonArray(pushSubscriptions.ToArray<JsonNode?>()),
        };
    }

    /// <summary>Deletes everything the user owns except the user document itself (the caller deletes that last).</summary>
    public async Task DeleteOwnedDataAsync(string userId, CancellationToken cancellationToken)
    {
        await grants.DeleteAllForUserAsync(userId, cancellationToken);
        await groups.DeleteAllForOwnerAsync(userId, cancellationToken);
        await mongo.Db.GetCollection<BsonDocument>(AlertSettingsCollection).DeleteManyAsync(new BsonDocument("userId", userId), cancellationToken);
        await mongo.Db.GetCollection<BsonDocument>(AlertsCollection).DeleteManyAsync(new BsonDocument("ownerId", userId), cancellationToken);
        await mongo.Db.GetCollection<BsonDocument>(PushSubscriptionsCollection).DeleteManyAsync(new BsonDocument("userId", userId), cancellationToken);
    }

    private async Task<List<JsonObject>> RawAsync(string collection, BsonDocument filter, CancellationToken cancellationToken, params string[] onlyFields)
    {
        var docs = await mongo.Db.GetCollection<BsonDocument>(collection).Find(filter).ToListAsync(cancellationToken);
        return docs.Select(d =>
        {
            var node = (JsonObject)ToJson(d)!;
            node.Remove("_id");
            if (onlyFields.Length > 0)
            {
                foreach (var key in node.Select(kv => kv.Key).Where(k => !onlyFields.Contains(k)).ToList())
                {
                    node.Remove(key);
                }
            }

            return node;
        }).ToList();
    }

    private static JsonObject Server(ServerDocument s) => new()
    {
        ["id"] = s.Id,
        ["name"] = s.Name,
        ["hostname"] = s.Hostname,
        ["tags"] = new JsonArray(s.Tags.Select(t => (JsonNode?)t).ToArray()),
        ["status"] = s.Status,
        ["lastSeenAt"] = Date(s.LastSeenAt),
        ["agentVersion"] = s.AgentVersion,
        ["os"] = s.Os is { } os ? new JsonObject { ["id"] = os.Id, ["versionId"] = os.VersionId, ["prettyName"] = os.PrettyName } : null,
        ["kernel"] = s.Kernel,
        ["arch"] = s.Arch,
        ["cores"] = s.Cores,
        ["ramBytes"] = s.RamBytes,
        ["dockerMode"] = s.DockerMode,
        ["kind"] = Glimt.Hub.Features.Agents.Protocol.NodeKinds.Normalize(s.Kind),
        ["containerId"] = s.ContainerId,
        ["image"] = s.Image,
        ["createdAt"] = Date(s.CreatedAt),
    };

    private static JsonObject Grant(AccessGrantDocument g) => new()
    {
        ["id"] = g.Id,
        ["ownerId"] = g.OwnerId,
        ["email"] = g.Email,
        ["userId"] = g.UserId,
        ["role"] = g.Role,
        ["scope"] = g.Scope == GrantScopes.All ? GrantScopes.All : new JsonArray(g.Tags.Select(t => (JsonNode?)t).ToArray()),
        ["status"] = g.Status,
        ["createdAt"] = Date(g.CreatedAt),
        ["acceptedAt"] = Date(g.AcceptedAt),
    };

    private static JsonNode? Date(DateTime? value) =>
        value is { } d ? new DateTimeOffset(DateTime.SpecifyKind(d, DateTimeKind.Utc)).ToString("O") : null;

    /// <summary>BSON → JSON without the extended-JSON wrappers ($date, $oid) so the export reads like the API.</summary>
    internal static JsonNode? ToJson(BsonValue value) => value.BsonType switch
    {
        BsonType.Document => new JsonObject(value.AsBsonDocument.Select(e => KeyValuePair.Create(e.Name, ToJson(e.Value)))),
        BsonType.Array => new JsonArray(value.AsBsonArray.Select(ToJson).ToArray()),
        BsonType.String => value.AsString,
        BsonType.Boolean => value.AsBoolean,
        BsonType.Int32 => value.AsInt32,
        BsonType.Int64 => value.AsInt64,
        BsonType.Double => value.AsDouble,
        BsonType.Decimal128 => (decimal)value.AsDecimal128,
        BsonType.DateTime => value.ToUniversalTime().ToString("O"),
        BsonType.ObjectId => value.AsObjectId.ToString(),
        BsonType.Null or BsonType.Undefined => null,
        _ => value.ToString(),
    };
}
