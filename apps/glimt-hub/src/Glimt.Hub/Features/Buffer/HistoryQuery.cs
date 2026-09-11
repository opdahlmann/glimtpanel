using System.Text.Json.Serialization;

namespace Glimt.Hub.Features.Buffer;

/// <summary>Answer of GET /api/servers/{id}/history. Percent metrics fill <c>values</c>; net fills <c>rx</c>/<c>tx</c>.</summary>
public sealed record HistoryResult(
    string Metric,
    string Range,
    long StepMs,
    long From,
    long To,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] double?[]? Values,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] double?[]? Rx,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] double?[]? Tx);

/// <summary>
/// Reads a metric out of a <see cref="ServerBuffer"/>: 1h = 120 buckets of 30 s (the raw points),
/// 24h = 288 buckets of 5 min. Percent metrics take the maximum per bucket, byte rates the average;
/// a bucket without a point is null (server down, hub restarted).
/// </summary>
public static class HistoryQuery
{
    public const string Range1h = "1h";
    public const string Range24h = "24h";
    public const long Step1hMs = 30_000;
    public const long Step24hMs = 300_000;
    public const int Points1h = 120;
    public const int Points24h = 288;

    public static bool TryParseRange(string? range, out long stepMs, out int buckets)
    {
        switch (range)
        {
            case Range1h:
                stepMs = Step1hMs;
                buckets = Points1h;
                return true;
            case Range24h:
                stepMs = Step24hMs;
                buckets = Points24h;
                return true;
            default:
                stepMs = 0;
                buckets = 0;
                return false;
        }
    }

    /// <summary>cpu | mem | swap | disk:&lt;path&gt; | net:&lt;iface&gt; | cont:&lt;id&gt; (cpu %) | cont:&lt;id&gt;:mem (memory % of limit)</summary>
    public static bool IsValidMetric(string? metric) =>
        metric is "cpu" or "mem" or "swap"
        || (metric is not null && (metric.StartsWith("disk:", StringComparison.Ordinal) || metric.StartsWith("net:", StringComparison.Ordinal) || metric.StartsWith("cont:", StringComparison.Ordinal)) && metric.Length > 5);

    /// <summary>Returns null when metric or range is invalid. An unknown mount/iface/container gives all-null series.</summary>
    public static HistoryResult? Query(ServerBuffer? buffer, string? metric, string? range, DateTimeOffset now)
    {
        if (!IsValidMetric(metric) || !TryParseRange(range, out var stepMs, out var buckets))
        {
            return null;
        }

        var to = (now.ToUnixTimeMilliseconds() / stepMs + 1) * stepMs;
        var from = to - buckets * stepMs;
        var points = buffer?.Since(from) ?? [];

        if (metric!.StartsWith("net:", StringComparison.Ordinal))
        {
            var index = buffer?.IfaceIndex(metric[4..]) ?? -1;
            var rx = Aggregate(points, buckets, from, stepMs, average: true, p => Slot(p.Net, index * 2));
            var tx = Aggregate(points, buckets, from, stepMs, average: true, p => Slot(p.Net, index * 2 + 1));
            return new HistoryResult(metric, range!, stepMs, from, to, null, rx, tx);
        }

        Func<Point, float> select = metric switch
        {
            "cpu" => p => p.Cpu,
            "mem" => p => p.Mem,
            "swap" => p => p.Swap,
            _ when metric.StartsWith("disk:", StringComparison.Ordinal) => DiskSelector(buffer?.MountIndex(metric[5..]) ?? -1),
            _ => ContainerSelector(buffer, metric[5..]),
        };
        var values = Aggregate(points, buckets, from, stepMs, average: false, select);
        return new HistoryResult(metric, range!, stepMs, from, to, values, null, null);
    }

    /// <summary>Last-hour cpu/mem for the Card, rounded to whole percent (1 byte each in MessagePack).</summary>
    public static int?[] LastHourPercent(ServerBuffer? buffer, string metric, DateTimeOffset now)
    {
        var result = Query(buffer, metric, Range1h, now);
        var values = result?.Values ?? new double?[Points1h];
        var rounded = new int?[values.Length];
        for (var i = 0; i < values.Length; i++)
        {
            rounded[i] = values[i] is { } v ? (int)Math.Round(v) : null;
        }

        return rounded;
    }

    private static Func<Point, float> DiskSelector(int index) => p => Slot(p.Disk, index);

    /// <summary>Cont is [cpu0, mem0, cpu1, mem1, …]: "&lt;id&gt;" reads the cpu slot, "&lt;id&gt;:mem" the memory slot.</summary>
    private static Func<Point, float> ContainerSelector(ServerBuffer? buffer, string spec)
    {
        var mem = spec.EndsWith(":mem", StringComparison.Ordinal);
        var id = mem ? spec[..^4] : spec;
        var index = buffer?.ContainerIndex(id) ?? -1;
        var slot = index < 0 ? -1 : index * 2 + (mem ? 1 : 0);
        return p => Slot(p.Cont, slot);
    }

    private static float Slot(float[] values, int index) => index >= 0 && index < values.Length ? values[index] : float.NaN;

    private static double?[] Aggregate(List<Point> points, int buckets, long from, long stepMs, bool average, Func<Point, float> select)
    {
        var sum = new double[buckets];
        var max = new double[buckets];
        var n = new int[buckets];
        foreach (var p in points)
        {
            var bucket = (int)((p.Ts - from) / stepMs);
            if (bucket < 0 || bucket >= buckets)
            {
                continue;
            }

            var v = select(p);
            if (float.IsNaN(v))
            {
                continue;
            }

            if (n[bucket] == 0 || v > max[bucket])
            {
                max[bucket] = v;
            }

            sum[bucket] += v;
            n[bucket]++;
        }

        var result = new double?[buckets];
        for (var i = 0; i < buckets; i++)
        {
            if (n[i] > 0)
            {
                result[i] = Math.Round(average ? sum[i] / n[i] : max[i], 1);
            }
        }

        return result;
    }
}
