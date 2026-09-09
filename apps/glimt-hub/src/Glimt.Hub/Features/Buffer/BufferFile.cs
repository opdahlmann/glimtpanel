using MessagePack;

namespace Glimt.Hub.Features.Buffer;

[MessagePackObject]
public sealed class BufferFileDocument
{
    public const int CurrentVersion = 1;

    [Key(0)]
    public int Version { get; set; } = CurrentVersion;

    [Key(1)]
    public long SavedAt { get; set; }

    [Key(2)]
    public List<ServerBufferDocument> Servers { get; set; } = [];
}

[MessagePackObject]
public sealed class ServerBufferDocument
{
    [Key(0)]
    public string ServerId { get; set; } = "";

    [Key(1)]
    public string[] Mounts { get; set; } = [];

    [Key(2)]
    public string[] Ifaces { get; set; } = [];

    [Key(3)]
    public string[] Containers { get; set; } = [];

    [Key(4)]
    public Point[] Points { get; set; } = [];
}

/// <summary>MessagePack round trip of every buffer to GLIMT_BUFFER_PATH/buffer.bin (IMPLEMENTERINGSPLAN 4.5).</summary>
public static class BufferFile
{
    public const string FileName = "buffer.bin";
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);

    private static readonly MessagePackSerializerOptions Options = MessagePackSerializerOptions.Standard;

    public static BufferFileDocument ToDocument(BufferStore store, DateTimeOffset savedAt)
    {
        var document = new BufferFileDocument { SavedAt = savedAt.ToUnixTimeMilliseconds() };
        foreach (var (serverId, buffer) in store.All)
        {
            document.Servers.Add(new ServerBufferDocument
            {
                ServerId = serverId,
                Mounts = buffer.Mounts.ToArray(),
                Ifaces = buffer.Ifaces.ToArray(),
                Containers = buffer.Containers.ToArray(),
                Points = buffer.ToArray(),
            });
        }

        return document;
    }

    /// <summary>Loads the servers into the store, discarding points older than 24 h. Returns the number of points kept.</summary>
    public static long Apply(BufferFileDocument document, BufferStore store, DateTimeOffset now)
    {
        var cutoff = (now - MaxAge).ToUnixTimeMilliseconds();
        long kept = 0;
        foreach (var server in document.Servers)
        {
            var points = server.Points.Where(p => p.Ts >= cutoff).OrderBy(p => p.Ts).ToArray();
            if (points.Length == 0)
            {
                continue;
            }

            store.GetOrAdd(server.ServerId).Load(server.Mounts, server.Ifaces, server.Containers, points);
            kept += points.Length;
        }

        return kept;
    }

    public static byte[] Serialize(BufferFileDocument document) => MessagePackSerializer.Serialize(document, Options);

    public static BufferFileDocument Deserialize(byte[] bytes) => MessagePackSerializer.Deserialize<BufferFileDocument>(bytes, Options);

    /// <summary>Writes buffer.bin.tmp and renames it over buffer.bin so a crash never leaves a half file.</summary>
    public static void Write(string directory, BufferFileDocument document)
    {
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, FileName);
        var tmp = path + ".tmp";
        File.WriteAllBytes(tmp, Serialize(document));
        File.Move(tmp, path, overwrite: true);
    }

    /// <summary>Null when there is no file. Throws on a corrupt file.</summary>
    public static BufferFileDocument? Read(string directory)
    {
        var path = Path.Combine(directory, FileName);
        if (!File.Exists(path))
        {
            return null;
        }

        var document = Deserialize(File.ReadAllBytes(path));
        if (document.Version != BufferFileDocument.CurrentVersion)
        {
            throw new InvalidDataException($"buffer file version {document.Version} is not supported (expected {BufferFileDocument.CurrentVersion})");
        }

        return document;
    }
}
