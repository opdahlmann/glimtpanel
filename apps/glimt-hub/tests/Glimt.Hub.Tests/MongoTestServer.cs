using Testcontainers.MongoDb;

namespace Glimt.Hub.Tests;

/// <summary>
/// One MongoDB container (Testcontainers) for the whole test run, started on first use and disposed at exit.
/// Each factory created with <see cref="HubFactory.WithMongo"/> gets its own database name, so test classes
/// can run in parallel against the same container.
/// </summary>
public static class MongoTestServer
{
    private static readonly Lazy<MongoDbContainer> Container = new(Start, LazyThreadSafetyMode.ExecutionAndPublication);

    public static string ConnectionString => Container.Value.GetConnectionString();

    private static MongoDbContainer Start()
    {
        var container = new MongoDbBuilder("mongo:8").Build();
        container.StartAsync().GetAwaiter().GetResult();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => container.DisposeAsync().AsTask().GetAwaiter().GetResult();
        return container;
    }
}
