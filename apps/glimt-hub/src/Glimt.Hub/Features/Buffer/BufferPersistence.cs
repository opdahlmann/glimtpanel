using System.Diagnostics;
using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Features.Buffer;

/// <summary>
/// Loads buffer.bin at startup and writes it every 15 minutes and when the application is stopping.
/// Does nothing when GLIMT_BUFFER_PATH is empty (tests).
/// </summary>
public sealed class BufferPersistence(BufferStore store, GlimtOptions options, IHostApplicationLifetime lifetime, TimeProvider clock, ILogger<BufferPersistence> logger) : IHostedService
{
    public static readonly TimeSpan SaveInterval = TimeSpan.FromMinutes(15);

    private readonly CancellationTokenSource _stop = new();
    private readonly Lock _saveLock = new();
    private Task? _loop;
    private CancellationTokenRegistration _stopping;

    public string? Directory => string.IsNullOrWhiteSpace(options.BufferPath) ? null : Path.GetFullPath(options.BufferPath);

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (Directory is not { } directory)
        {
            logger.LogInformation("buffer persistence off: GLIMT_BUFFER_PATH is empty");
            return Task.CompletedTask;
        }

        Load(directory);
        _stopping = lifetime.ApplicationStopping.Register(() => Save("shutdown"));
        _loop = Task.Run(() => LoopAsync(_stop.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await _stop.CancelAsync();
        _stopping.Dispose();
        if (_loop is not null)
        {
            try
            {
                await _loop.WaitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                // the loop only sleeps; nothing to wait for
            }
        }
    }

    /// <summary>Writes the file now. Returns false when persistence is off or the write failed.</summary>
    public bool Save(string reason)
    {
        if (Directory is not { } directory)
        {
            return false;
        }

        lock (_saveLock)
        {
            var watch = Stopwatch.StartNew();
            try
            {
                var now = clock.GetUtcNow();
                var document = BufferFile.ToDocument(store, now);
                BufferFile.Write(directory, document);
                store.LastSavedAt = now;
                logger.LogInformation("buffer saved ({Reason}): {Servers} servers, {Points} points in {Elapsed} ms", reason, document.Servers.Count, document.Servers.Sum(s => s.Points.LongLength), watch.ElapsedMilliseconds);
                return true;
            }
            catch (Exception ex)
            {
                logger.LogWarning("buffer not saved to {Directory}: {Error}", directory, ex.Message);
                return false;
            }
        }
    }

    private void Load(string directory)
    {
        try
        {
            var document = BufferFile.Read(directory);
            if (document is null)
            {
                logger.LogInformation("no buffer file in {Directory}; starting empty", directory);
                return;
            }

            var kept = BufferFile.Apply(document, store, clock.GetUtcNow());
            logger.LogInformation("buffer loaded from {Directory}: {Servers} servers, {Points} points kept (saved {SavedAt:o})", directory, store.ServerCount, kept, DateTimeOffset.FromUnixTimeMilliseconds(document.SavedAt));
        }
        catch (Exception ex)
        {
            logger.LogWarning("buffer file in {Directory} could not be read ({Error}); starting empty", directory, ex.Message);
        }
    }

    private async Task LoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var timer = new PeriodicTimer(SaveInterval);
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                Save("periodic");
            }
        }
        catch (OperationCanceledException)
        {
            // stopping
        }
    }
}
