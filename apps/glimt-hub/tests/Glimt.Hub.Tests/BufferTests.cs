using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Glimt.Hub.Features.Agents;
using Glimt.Hub.Features.Buffer;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Glimt.Hub.Tests;

public sealed class BufferTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 10, 12, 0, 0, TimeSpan.Zero);

    private static PointInput Point(long ts, float cpu, float mem = 50, float rx = 1000, float contCpu = 5) => new(
        ts, cpu, mem, 0,
        [new DiskInput("/", 40), new DiskInput("/data", 70)],
        [new IfaceInput("eth0", rx, rx / 2)],
        [new ContainerInput("c1", contCpu, 30)]);

    [Fact]
    public void Ring_buffer_wraps_and_keeps_the_newest_2880_points()
    {
        var buffer = new ServerBuffer();
        for (var i = 0; i < ServerBuffer.Capacity + 100; i++)
        {
            buffer.Add(Point(i * 30_000L, i % 100));
        }

        Assert.Equal(ServerBuffer.Capacity, buffer.Count);
        var points = buffer.ToArray();
        Assert.Equal(100 * 30_000L, points[0].Ts);
        Assert.Equal((ServerBuffer.Capacity + 99) * 30_000L, points[^1].Ts);
        Assert.Equal((ServerBuffer.Capacity + 99) * 30_000L, buffer.LatestTs);
        Assert.Equal(["/", "/data"], buffer.Mounts);
        Assert.Equal(0, buffer.MountIndex("/"));
        Assert.Equal(-1, buffer.MountIndex("/nope"));
    }

    [Fact]
    public void Tables_grow_and_old_points_read_nan_for_new_slots()
    {
        var buffer = new ServerBuffer();
        buffer.Add(Point(0, 10));
        buffer.Add(new PointInput(30_000, 20, 50, 0, [new DiskInput("/", 40)], [], [new ContainerInput("c1", 1, 1), new ContainerInput("c2", 2, 2)]));
        var points = buffer.ToArray();
        Assert.Equal(2, points[0].Cont.Length);
        Assert.Equal(4, points[1].Cont.Length);
        Assert.Equal(1, buffer.ContainerIndex("c2"));
        Assert.True(float.IsNaN(points[1].Net[0]), "an interface not reported in the point is NaN");
    }

    [Fact]
    public void One_hour_query_returns_120_raw_slots_with_gaps()
    {
        var buffer = new ServerBuffer();
        var nowMs = Now.ToUnixTimeMilliseconds();
        for (var i = 0; i < 60; i++)
        {
            if (i is >= 20 and < 30)
            {
                continue; // ten missing points = a five-minute gap
            }

            buffer.Add(Point(nowMs - (60 - i) * 30_000L, i));
        }

        var result = HistoryQuery.Query(buffer, "cpu", "1h", Now)!;
        Assert.Equal(30_000, result.StepMs);
        Assert.Equal(120, result.Values!.Length);
        Assert.Equal(result.From + 120 * 30_000, result.To);
        Assert.Null(result.Values[0]);
        Assert.Equal(59, result.Values[^2]);
        Assert.Equal(11, result.Values.Skip(60).Count(v => v is null)); // the ten-point gap plus the not yet filled last slot
        Assert.Equal(19, result.Values[78]);
        Assert.Null(result.Values[80]);
        Assert.Equal(30, result.Values[89]);
        Assert.Null(result.Rx);
        Assert.Null(result.Tx);

        var disk = HistoryQuery.Query(buffer, "disk:/data", "1h", Now)!;
        Assert.Equal(70, disk.Values![^2]);
        Assert.Null(HistoryQuery.Query(buffer, "cpu", "2h", Now));
        Assert.Null(HistoryQuery.Query(buffer, "cpux", "1h", Now));
    }

    [Fact]
    public void Twenty_four_hour_query_downsamples_max_for_percent_and_average_for_bytes()
    {
        var buffer = new ServerBuffer();
        var nowMs = Now.ToUnixTimeMilliseconds();
        // Ten points inside one five-minute bucket, well inside the window.
        var bucketStart = (nowMs - 3_600_000) / 300_000 * 300_000;
        for (var i = 0; i < 10; i++)
        {
            buffer.Add(Point(bucketStart + i * 30_000L, cpu: 10 + i, rx: 100 * (i + 1), contCpu: i));
        }

        var cpu = HistoryQuery.Query(buffer, "cpu", "24h", Now)!;
        Assert.Equal(300_000, cpu.StepMs);
        Assert.Equal(288, cpu.Values!.Length);
        var index = (int)((bucketStart - cpu.From) / 300_000);
        Assert.Equal(19, cpu.Values[index]);
        Assert.Null(cpu.Values[index + 1]);
        Assert.Equal(287, cpu.Values.Count(v => v is null));

        var net = HistoryQuery.Query(buffer, "net:eth0", "24h", Now)!;
        Assert.Null(net.Values);
        Assert.Equal(550, net.Rx![index]);
        Assert.Equal(275, net.Tx![index]);

        var cont = HistoryQuery.Query(buffer, "cont:c1", "24h", Now)!;
        Assert.Equal(9, cont.Values![index]);
        Assert.Null(HistoryQuery.Query(buffer, "cont:unknown", "24h", Now)!.Values![index]);
    }

    [Fact]
    public void Message_pack_round_trip_keeps_points_and_tables_and_drops_old_points()
    {
        var store = new BufferStore();
        var nowMs = Now.ToUnixTimeMilliseconds();
        store.Record("s1", Point(nowMs - 25 * 3_600_000L, 1));
        store.Record("s1", Point(nowMs - 60_000, 2));
        store.Record("s1", Point(nowMs - 30_000, 3));
        store.Record("s2", Point(nowMs - 30 * 3_600_000L, 9));

        var bytes = BufferFile.Serialize(BufferFile.ToDocument(store, Now));
        var document = BufferFile.Deserialize(bytes);
        Assert.Equal(BufferFileDocument.CurrentVersion, document.Version);
        Assert.Equal(2, document.Servers.Count);

        var restored = new BufferStore();
        Assert.Equal(2, BufferFile.Apply(document, restored, Now));
        var s1 = restored.Get("s1")!;
        Assert.Equal(2, s1.Count);
        Assert.Equal(["/", "/data"], s1.Mounts);
        Assert.Equal(["eth0"], s1.Ifaces);
        Assert.Equal(["c1"], s1.Containers);
        Assert.Equal(3, s1.ToArray()[^1].Cpu);
        Assert.Equal(500, s1.ToArray()[^1].Net[1]);
        Assert.Null(restored.Get("s2"));
    }

    [Fact]
    public void Corrupt_file_throws_and_the_persistence_starts_empty()
    {
        var dir = Path.Combine(Path.GetTempPath(), "glimt-buffer-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllBytes(Path.Combine(dir, BufferFile.FileName), [1, 2, 3, 4, 5]);
            Assert.ThrowsAny<Exception>(() => BufferFile.Read(dir));
            Assert.Null(BufferFile.Read(Path.Combine(dir, "missing")));
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void A_thousand_full_buffers_fit_the_memory_budget()
    {
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CI")) || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("GLIMT_SKIP_SLOW_TESTS")))
        {
            return; // slow: skipped in CI
        }

        var before = GC.GetTotalMemory(forceFullCollection: true);
        var buffers = new List<ServerBuffer>(1000);
        var input = new PointInput(
            0, 50, 50, 0,
            [new DiskInput("/", 40), new DiskInput("/data", 70)],
            [new IfaceInput("eth0", 1, 1), new IfaceInput("docker0", 1, 1)],
            Enumerable.Range(0, 8).Select(i => new ContainerInput("c" + i, 1, 1)).ToList());
        for (var s = 0; s < 1000; s++)
        {
            var buffer = new ServerBuffer();
            for (var i = 0; i < ServerBuffer.Capacity; i++)
            {
                buffer.Add(input with { Ts = i * 30_000L });
            }

            buffers.Add(buffer);
        }

        var after = GC.GetTotalMemory(forceFullCollection: true);
        var bytes = after - before;
        Assert.True(bytes < 4L * 1024 * 1024 * 1024, $"1 000 full buffers use {bytes / 1_000_000} MB");
        GC.KeepAlive(buffers);
    }

    [Fact]
    public async Task Buffer_is_written_to_the_path_and_read_back_by_the_next_hub()
    {
        var ct = Repo.Timeout(30);
        var dir = Path.Combine(Path.GetTempPath(), "glimt-buffer-" + Guid.NewGuid().ToString("N"));
        try
        {
            using (var first = new BufferPathFactory(dir))
            {
                var (agent, _, serverId) = await LiveTestSupport.ConnectAgentAsync(first, "persist-host", ct);
                await agent.SendAsync(Repo.Example("snapshot"), ct);
                var store = first.Services.GetRequiredService<BufferStore>();
                while (store.Get(serverId) is null)
                {
                    await Task.Delay(20, ct);
                }

                await agent.DisposeAsync();
                Assert.True(first.Services.GetRequiredService<BufferPersistence>().Save("test"));
                Assert.NotNull(store.LastSavedAt);
                Assert.True(File.Exists(Path.Combine(dir, BufferFile.FileName)));
                Assert.False(File.Exists(Path.Combine(dir, BufferFile.FileName + ".tmp")));

                using var client = first.CreateClient();
                var health = await client.GetFromJsonAsync<JsonElement>("/healthz", ct);
                Assert.True(health.GetProperty("buffer").GetProperty("servers").GetInt32() >= 1);
                Assert.NotNull(health.GetProperty("buffer").GetProperty("lastSavedAt").GetString());
            }

            using var second = new BufferPathFactory(dir);
            var reloaded = second.Services.GetRequiredService<BufferStore>().Get("dev-persist-host");
            Assert.NotNull(reloaded);
            Assert.Equal(1, reloaded.Count);
            Assert.Equal(48.2f, reloaded.ToArray()[0].Cpu, 0.01f);
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
        }
    }

    [Fact]
    public async Task History_endpoint_serves_the_last_hour_after_snapshots()
    {
        var ct = Repo.Timeout(30);
        using var factory = new HubFactory();
        var (agent, _, serverId) = await LiveTestSupport.ConnectAgentAsync(factory, "hist-host", ct);
        await using var agentScope = agent;
        var registry = factory.Services.GetRequiredService<AgentRegistry>();
        Assert.True(registry.TryGet(serverId, out var session));
        foreach (var cpu in new[] { 10.0, 90.0, 40.0 })
        {
            var snapshot = Repo.Example("snapshot").AsObject();
            snapshot["host"]!["cpu"]!["total"] = cpu;
            await agent.SendAsync(snapshot, ct);
            var before = session.SnapshotAt;
            while (session.SnapshotAt == before || session.LastSnapshot!.Host.Cpu.Total != cpu)
            {
                await Task.Delay(10, ct);
            }
        }

        using var client = LiveTestSupport.Bearer(factory, LiveTestSupport.Token(factory));
        var response = await client.GetAsync($"/api/servers/{serverId}/history?metric=cpu&range=1h", ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("cpu", body.GetProperty("metric").GetString());
        Assert.Equal("1h", body.GetProperty("range").GetString());
        Assert.Equal(30_000, body.GetProperty("stepMs").GetInt64());
        var values = body.GetProperty("values").EnumerateArray().ToArray();
        Assert.Equal(120, values.Length);
        var present = values.Where(v => v.ValueKind == JsonValueKind.Number).Select(v => v.GetDouble()).ToArray();
        Assert.NotEmpty(present);
        Assert.Equal(90.0, present.Max());

        var net = await client.GetFromJsonAsync<JsonElement>($"/api/servers/{serverId}/history?metric=net:eth0&range=24h", ct);
        Assert.Equal(288, net.GetProperty("rx").GetArrayLength());
        Assert.False(net.TryGetProperty("values", out _));

        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync($"/api/servers/{serverId}/history?metric=cpu&range=7d", ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/servers/nope/history?metric=cpu&range=1h", ct)).StatusCode);
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync($"/api/servers/{serverId}/history?metric=cpu&range=1h", ct)).StatusCode);
    }

    private sealed class BufferPathFactory(string dir) : HubFactory
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            base.ConfigureWebHost(builder);
            builder.UseSetting("BUFFER_PATH", dir);
        }
    }
}
