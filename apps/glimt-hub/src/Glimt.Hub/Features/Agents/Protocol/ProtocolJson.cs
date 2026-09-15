using System.Text.Json;
using System.Text.Json.Serialization;

namespace Glimt.Hub.Features.Agents.Protocol;

/// <summary>One parsed frame: the discriminator, the typed message (null for unknown types) and the raw JSON.</summary>
public sealed record Envelope(string Type, AgentMessage? Message, JsonElement Raw);

public sealed class ProtocolException(string message) : Exception(message);

/// <summary>System.Text.Json wiring for the agent protocol: camelCase, `type` first, nulls omitted.</summary>
public static class ProtocolJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        MaxDepth = Infrastructure.RequestLimits.MaxJsonDepth,
    };

    public static byte[] Serialize(AgentMessage message) =>
        JsonSerializer.SerializeToUtf8Bytes(message, message.GetType(), Options);

    public static string SerializeToString(AgentMessage message) =>
        JsonSerializer.Serialize(message, message.GetType(), Options);

    /// <summary>Reads `type` from the frame and deserializes the matching record.</summary>
    /// <exception cref="ProtocolException">Not an object, or `type` missing.</exception>
    /// <exception cref="JsonException">Malformed JSON or a payload that does not fit the record.</exception>
    public static Envelope Parse(ReadOnlyMemory<byte> utf8Json)
    {
        using var document = JsonDocument.Parse(utf8Json);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new ProtocolException("message must be a JSON object");
        }

        if (!root.TryGetProperty("type", out var typeElement) || typeElement.ValueKind != JsonValueKind.String)
        {
            throw new ProtocolException("message has no string 'type' field");
        }

        var type = typeElement.GetString()!;
        return new Envelope(type, Deserialize(type, root), root.Clone());
    }

    public static Envelope Parse(string json) => Parse(System.Text.Encoding.UTF8.GetBytes(json));

    private static AgentMessage? Deserialize(string type, JsonElement root) => type switch
    {
        MessageTypes.Hello => root.Deserialize<Hello>(Options),
        MessageTypes.Snapshot => root.Deserialize<Snapshot>(Options),
        MessageTypes.Stream => root.Deserialize<Stream>(Options),
        MessageTypes.Log => root.Deserialize<Log>(Options),
        MessageTypes.LogEnd => root.Deserialize<LogEnd>(Options),
        MessageTypes.Pong => root.Deserialize<Pong>(Options),
        MessageTypes.Bye => root.Deserialize<Bye>(Options),
        MessageTypes.Welcome => root.Deserialize<Welcome>(Options),
        MessageTypes.AuthFailed => root.Deserialize<AuthFailed>(Options),
        MessageTypes.Subscribe => root.Deserialize<Subscribe>(Options),
        MessageTypes.Unsubscribe => root.Deserialize<Unsubscribe>(Options),
        MessageTypes.LogStart => root.Deserialize<LogStart>(Options),
        MessageTypes.LogStop => root.Deserialize<LogStop>(Options),
        MessageTypes.Rotate => root.Deserialize<Rotate>(Options),
        MessageTypes.Ping => root.Deserialize<Ping>(Options),
        _ => null,
    };
}
