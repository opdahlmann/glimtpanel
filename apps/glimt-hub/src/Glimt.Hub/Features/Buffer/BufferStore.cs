using System.Collections.Concurrent;

namespace Glimt.Hub.Features.Buffer;

/// <summary>All ring buffers, one per server, in process memory (IMPLEMENTERINGSPLAN 4.5).</summary>
public sealed class BufferStore
{
    private readonly ConcurrentDictionary<string, ServerBuffer> _buffers = new(StringComparer.Ordinal);

    public int ServerCount => _buffers.Count;

    public long TotalPoints => _buffers.Values.Sum(b => (long)b.Count);

    /// <summary>When the persistence last wrote buffer.bin (null when persistence is off or nothing saved yet).</summary>
    public DateTimeOffset? LastSavedAt { get; set; }

    public ServerBuffer GetOrAdd(string serverId) => _buffers.GetOrAdd(serverId, static _ => new ServerBuffer());

    public ServerBuffer? Get(string serverId) => _buffers.TryGetValue(serverId, out var buffer) ? buffer : null;

    public void Record(string serverId, PointInput point) => GetOrAdd(serverId).Add(point);

    public bool Remove(string serverId) => _buffers.TryRemove(serverId, out _);

    public IReadOnlyList<KeyValuePair<string, ServerBuffer>> All => _buffers.ToArray();
}
