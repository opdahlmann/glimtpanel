using MessagePack;

namespace Glimt.Hub.Features.Buffer;

/// <summary>
/// One 30-second sample: percentages for the host, disk per mount, byte rates per interface and cpu/mem
/// per container. The dynamic parts are arrays indexed through the per-server tables in
/// <see cref="ServerBuffer"/>; a slot that did not exist or was not reported holds NaN.
/// Net is [rx0, tx0, rx1, tx1, …], Cont is [cpu0, mem0, cpu1, mem1, …]. About 1 kB per point.
/// </summary>
[MessagePackObject]
public readonly record struct Point(
    [property: Key(0)] long Ts,
    [property: Key(1)] float Cpu,
    [property: Key(2)] float Mem,
    [property: Key(3)] float Swap,
    [property: Key(4)] float[] Disk,
    [property: Key(5)] float[] Net,
    [property: Key(6)] float[] Cont);

public readonly record struct DiskInput(string Path, float Pct);

public readonly record struct IfaceInput(string Name, float RxBps, float TxBps);

public readonly record struct ContainerInput(string Id, float CpuPct, float MemPct);

/// <summary>What one snapshot contributes to the buffer (built by the Agents feature).</summary>
public sealed record PointInput(
    long Ts,
    float Cpu,
    float Mem,
    float Swap,
    IReadOnlyList<DiskInput> Disks,
    IReadOnlyList<IfaceInput> Ifaces,
    IReadOnlyList<ContainerInput> Containers);

/// <summary>
/// Ring buffer of 2 880 points (30 s × 24 h) for one server plus the id tables that name the array
/// slots. Tables only grow; an id that comes back keeps its slot. Thread-safe.
/// </summary>
public sealed class ServerBuffer
{
    public const int Capacity = 2880;

    private readonly Lock _lock = new();
    private readonly Point[] _points = new Point[Capacity];
    private readonly List<string> _mounts = [];
    private readonly List<string> _ifaces = [];
    private readonly List<string> _containers = [];
    private readonly Dictionary<string, int> _mountIndex = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _ifaceIndex = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _containerIndex = new(StringComparer.Ordinal);
    private int _start;
    private int _count;

    public int Count
    {
        get
        {
            lock (_lock)
            {
                return _count;
            }
        }
    }

    public long? LatestTs
    {
        get
        {
            lock (_lock)
            {
                return _count == 0 ? null : _points[(_start + _count - 1) % Capacity].Ts;
            }
        }
    }

    public IReadOnlyList<string> Mounts
    {
        get
        {
            lock (_lock)
            {
                return _mounts.ToArray();
            }
        }
    }

    public IReadOnlyList<string> Ifaces
    {
        get
        {
            lock (_lock)
            {
                return _ifaces.ToArray();
            }
        }
    }

    public IReadOnlyList<string> Containers
    {
        get
        {
            lock (_lock)
            {
                return _containers.ToArray();
            }
        }
    }

    public int MountIndex(string path) => IndexOf(_mountIndex, path);

    public int IfaceIndex(string name) => IndexOf(_ifaceIndex, name);

    public int ContainerIndex(string id) => IndexOf(_containerIndex, id);

    public void Add(PointInput input)
    {
        lock (_lock)
        {
            foreach (var d in input.Disks)
            {
                Slot(_mounts, _mountIndex, d.Path);
            }

            foreach (var i in input.Ifaces)
            {
                Slot(_ifaces, _ifaceIndex, i.Name);
            }

            foreach (var c in input.Containers)
            {
                Slot(_containers, _containerIndex, c.Id);
            }

            var disk = Filled(_mounts.Count);
            foreach (var d in input.Disks)
            {
                disk[_mountIndex[d.Path]] = d.Pct;
            }

            var net = Filled(_ifaces.Count * 2);
            foreach (var i in input.Ifaces)
            {
                var slot = _ifaceIndex[i.Name] * 2;
                net[slot] = i.RxBps;
                net[slot + 1] = i.TxBps;
            }

            var cont = Filled(_containers.Count * 2);
            foreach (var c in input.Containers)
            {
                var slot = _containerIndex[c.Id] * 2;
                cont[slot] = c.CpuPct;
                cont[slot + 1] = c.MemPct;
            }

            Append(new Point(input.Ts, input.Cpu, input.Mem, input.Swap, disk, net, cont));
        }
    }

    /// <summary>Oldest → newest copy of the points.</summary>
    public Point[] ToArray()
    {
        lock (_lock)
        {
            var result = new Point[_count];
            for (var i = 0; i < _count; i++)
            {
                result[i] = _points[(_start + i) % Capacity];
            }

            return result;
        }
    }

    /// <summary>Points with Ts ≥ <paramref name="sinceTs"/>, oldest → newest.</summary>
    public List<Point> Since(long sinceTs)
    {
        lock (_lock)
        {
            var result = new List<Point>();
            for (var i = 0; i < _count; i++)
            {
                var p = _points[(_start + i) % Capacity];
                if (p.Ts >= sinceTs)
                {
                    result.Add(p);
                }
            }

            return result;
        }
    }

    /// <summary>Replaces the content (persistence load). Points must be oldest → newest and sized for the tables.</summary>
    public void Load(IEnumerable<string> mounts, IEnumerable<string> ifaces, IEnumerable<string> containers, IEnumerable<Point> points)
    {
        lock (_lock)
        {
            _mounts.Clear();
            _mountIndex.Clear();
            _ifaces.Clear();
            _ifaceIndex.Clear();
            _containers.Clear();
            _containerIndex.Clear();
            _start = 0;
            _count = 0;
            foreach (var m in mounts)
            {
                Slot(_mounts, _mountIndex, m);
            }

            foreach (var i in ifaces)
            {
                Slot(_ifaces, _ifaceIndex, i);
            }

            foreach (var c in containers)
            {
                Slot(_containers, _containerIndex, c);
            }

            foreach (var p in points)
            {
                Append(p);
            }
        }
    }

    private void Append(Point point)
    {
        if (_count < Capacity)
        {
            _points[(_start + _count) % Capacity] = point;
            _count++;
        }
        else
        {
            _points[_start] = point;
            _start = (_start + 1) % Capacity;
        }
    }

    private int IndexOf(Dictionary<string, int> index, string key)
    {
        lock (_lock)
        {
            return index.TryGetValue(key, out var i) ? i : -1;
        }
    }

    private static void Slot(List<string> table, Dictionary<string, int> index, string key)
    {
        if (!index.ContainsKey(key))
        {
            index[key] = table.Count;
            table.Add(key);
        }
    }

    private static float[] Filled(int length)
    {
        if (length == 0)
        {
            return [];
        }

        var array = new float[length];
        Array.Fill(array, float.NaN);
        return array;
    }
}
