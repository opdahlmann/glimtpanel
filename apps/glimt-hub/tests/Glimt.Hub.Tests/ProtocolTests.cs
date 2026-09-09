using System.Text.Json;
using Glimt.Hub.Features.Agents.Protocol;

namespace Glimt.Hub.Tests;

public sealed class ProtocolTests
{
    public static TheoryData<string> ExampleFiles()
    {
        var data = new TheoryData<string>();
        foreach (var file in Directory.GetFiles(Repo.ExamplesDir, "*.json").Order())
        {
            data.Add(Path.GetFileName(file));
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(ExampleFiles))]
    public void Every_protocol_example_deserializes_into_its_record(string fileName)
    {
        var expectedType = Path.GetFileNameWithoutExtension(fileName);
        var bytes = File.ReadAllBytes(Path.Combine(Repo.ExamplesDir, fileName));

        var envelope = ProtocolJson.Parse(bytes);

        Assert.Equal(expectedType, envelope.Type);
        Assert.NotNull(envelope.Message);
        Assert.Equal(expectedType, envelope.Message.Type);
        Assert.Equal(JsonValueKind.Object, envelope.Raw.ValueKind);

        // Round trip: what we serialize must parse back to the same record type.
        var again = ProtocolJson.Parse(ProtocolJson.Serialize(envelope.Message));
        Assert.Equal(envelope.Message.GetType(), again.Message?.GetType());
    }

    [Fact]
    public void Examples_directory_is_not_empty()
    {
        Assert.NotEmpty(ExampleFiles());
    }

    [Fact]
    public void Snapshot_example_maps_nested_fields()
    {
        var snapshot = Assert.IsType<Snapshot>(ProtocolJson.Parse(Repo.Example("snapshot").ToJsonString()).Message);

        Assert.Equal(48.2, snapshot.Host.Cpu.Total);
        Assert.Equal(10.6, snapshot.Host.Cpu.SystemTime);
        Assert.Equal([51, 44, 49, 48], snapshot.Host.Cpu.PerCore);
        Assert.Equal(8589934592, snapshot.Host.Mem.Total);
        Assert.Equal("/", Assert.Single(snapshot.Host.Mounts!).Path);
        Assert.Equal("web-web", Assert.Single(snapshot.Containers!).Name);
        Assert.Equal(["cron-sync.service"], snapshot.Services!.Failed);
        Assert.True(snapshot.Maintenance!.RebootRequired);
        Assert.Equal(42, snapshot.Security!.Firewall!.Banned);
    }

    [Fact]
    public void Type_is_serialized_first_and_nulls_are_omitted()
    {
        var json = ProtocolJson.SerializeToString(new Welcome("srv", null, 30_000, 600_000));

        Assert.StartsWith("{\"type\":\"welcome\"", json);
        Assert.DoesNotContain("token", json);

        var withToken = ProtocolJson.SerializeToString(new Welcome("srv", "agt_x", 30_000, 600_000));
        Assert.Contains("\"token\":\"agt_x\"", withToken);
    }

    [Fact]
    public void Unknown_type_gives_envelope_without_message()
    {
        var envelope = ProtocolJson.Parse("""{"type":"somethingNew","x":1}""");

        Assert.Equal("somethingNew", envelope.Type);
        Assert.Null(envelope.Message);
        Assert.Equal(1, envelope.Raw.GetProperty("x").GetInt32());
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("""{"type":1}""")]
    public void Frames_without_a_type_are_rejected(string json)
    {
        Assert.Throws<ProtocolException>(() => ProtocolJson.Parse(json));
    }

    [Fact]
    public void Malformed_json_throws_json_exception()
    {
        Assert.ThrowsAny<JsonException>(() => ProtocolJson.Parse("{\"type\":"));
    }
}
