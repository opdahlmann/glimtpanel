using MongoDB.Bson;
using MongoDB.Bson.Serialization.Conventions;
using MongoDB.Driver;

namespace Glimt.Hub.Infrastructure;

/// <summary>
/// One MongoClient for the process. The hub must start and serve /healthz even when MongoDB is
/// unreachable, so the connection is verified in the background (<see cref="MongoConnectService"/>)
/// and features check <see cref="IsAvailable"/> before touching the database.
/// </summary>
public sealed class MongoContext : IDisposable
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(3);
    private static int _conventionsRegistered;

    private readonly TaskCompletionSource<bool> _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly ILogger<MongoContext> _logger;
    private int _failures;

    public MongoContext(GlimtOptions options, ILogger<MongoContext> logger)
    {
        _logger = logger;
        RegisterConventions();

        var settings = MongoClientSettings.FromConnectionString(NormalizeConnectionString(options.MongoUri));
        settings.ApplicationName = "glimt-hub";
        if (!options.MongoUri.Contains("serverSelectionTimeoutMS", StringComparison.OrdinalIgnoreCase))
        {
            settings.ServerSelectionTimeout = DefaultTimeout;
        }

        if (!options.MongoUri.Contains("connectTimeoutMS", StringComparison.OrdinalIgnoreCase))
        {
            settings.ConnectTimeout = DefaultTimeout;
        }

        Client = new MongoClient(settings);
        DatabaseName = options.MongoDb;
        Db = Client.GetDatabase(DatabaseName);
    }

    /// <summary>
    /// Compass og mongosh godtar <c>authMechanism=DEFAULT</c>, men .NET-driveren feiler med «Unable to create an authenticator».
    /// Parameteren fjernes (driverens standard er SCRAM-forhandling) så en streng limt fra Compass virker uendret.
    /// </summary>
    internal static string NormalizeConnectionString(string uri)
    {
        var cleaned = System.Text.RegularExpressions.Regex.Replace(uri, @"([?&])authMechanism=DEFAULT(&|$)", "$1", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return cleaned.Replace("?&", "?").TrimEnd('&', '?');
    }

    public IMongoClient Client { get; }
    public IMongoDatabase Db { get; }
    public string DatabaseName { get; }

    /// <summary>True once a ping has succeeded.</summary>
    public bool IsAvailable { get; private set; }

    public string? UnavailableReason { get; private set; }

    /// <summary>Completes with the result of the first ping. Used by seeders that need the database.</summary>
    public Task<bool> Ready => _ready.Task;

    /// <summary>Pings the database once and records the outcome.</summary>
    public async Task<bool> PingAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Db.RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1), cancellationToken: cancellationToken);
            IsAvailable = true;
            UnavailableReason = null;
            _logger.LogInformation("connected to MongoDB {Database}", DatabaseName);
            _ready.TrySetResult(true);
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            IsAvailable = false;
            UnavailableReason = ex.GetBaseException().Message;
            if (_failures++ == 0)
            {
                _logger.LogWarning("MongoDB {Database} unavailable: {Reason}. The hub keeps running without persistence.", DatabaseName, UnavailableReason);
            }
            else
            {
                _logger.LogDebug("MongoDB {Database} still unavailable: {Reason}", DatabaseName, UnavailableReason);
            }

            _ready.TrySetResult(false);
            return false;
        }
    }

    public void Dispose()
    {
        _ready.TrySetResult(false);
        Client.Dispose();
    }

    private static void RegisterConventions()
    {
        if (Interlocked.Exchange(ref _conventionsRegistered, 1) == 1)
        {
            return;
        }

        var pack = new ConventionPack
        {
            new CamelCaseElementNameConvention(),
            new IgnoreExtraElementsConvention(true),
        };
        ConventionRegistry.Register("glimt", pack, _ => true);
    }
}

/// <summary>Verifies the MongoDB connection in the background so startup is never blocked by the database.</summary>
internal sealed class MongoConnectService(MongoContext mongo) : BackgroundService
{
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();
        while (!stoppingToken.IsCancellationRequested)
        {
            if (await mongo.PingAsync(stoppingToken))
            {
                return;
            }

            try
            {
                await Task.Delay(RetryInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

}
