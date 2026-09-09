using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Agents;

/// <summary>
/// Small read-mostly view of the users collection for the real-time side: the developer account's id
/// (owner of dev-key servers) and find-or-create for the demo account. Every call is a no-op / null when
/// MongoDB is unavailable; results are cached for a minute.
/// </summary>
public sealed class UserDirectory(MongoContext mongo, GlimtOptions options, TimeProvider clock, ILogger<UserDirectory> logger)
{
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(1);
    private readonly Lock _lock = new();
    private readonly Dictionary<string, (string? Id, DateTimeOffset At)> _cache = new(StringComparer.Ordinal);

    /// <summary>The seeded dev user's id (GLIMT_DEV_USER_EMAIL), or null outside development or without MongoDB.</summary>
    public Task<string?> DevUserIdAsync(CancellationToken cancellationToken)
    {
        if (!options.IsDevelopmentLike || string.IsNullOrWhiteSpace(options.DevUserEmail))
        {
            return Task.FromResult<string?>(null);
        }

        return FindIdByEmailAsync(options.DevUserEmail, cancellationToken);
    }

    public async Task<string?> FindIdByEmailAsync(string email, CancellationToken cancellationToken)
    {
        email = email.Trim().ToLowerInvariant();
        var now = clock.GetUtcNow();
        lock (_lock)
        {
            if (_cache.TryGetValue(email, out var hit) && hit.Id is not null && now - hit.At < CacheFor)
            {
                return hit.Id;
            }
        }

        if (!mongo.IsAvailable)
        {
            return null;
        }

        try
        {
            var user = await mongo.Db.GetCollection<UserDocument>(UserDocument.Collection)
                .Find(u => u.Email == email)
                .Project(u => u.Id)
                .FirstOrDefaultAsync(cancellationToken);
            lock (_lock)
            {
                _cache[email] = (user, now);
            }

            return user;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("could not look up user {Email}: {Error}", email, ex.Message);
            return null;
        }
    }

    /// <summary>Finds the user or creates it without a usable password (demo account). Null without MongoDB.</summary>
    public async Task<string?> EnsureUserAsync(string email, string name, CancellationToken cancellationToken)
    {
        email = email.Trim().ToLowerInvariant();
        var existing = await FindIdByEmailAsync(email, cancellationToken);
        if (existing is not null || !mongo.IsAvailable)
        {
            return existing;
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var user = new UserDocument
        {
            Email = email,
            Name = name,
            PasswordHash = "",
            EmailConfirmedAt = now,
            Plan = "beta",
            Timezone = "Europe/Oslo",
            Language = "en",
            CreatedAt = now,
        };
        try
        {
            await mongo.Db.GetCollection<UserDocument>(UserDocument.Collection).InsertOneAsync(user, cancellationToken: cancellationToken);
            logger.LogInformation("created user {Email} in {Database}", email, mongo.DatabaseName);
            lock (_lock)
            {
                _cache[email] = (user.Id, clock.GetUtcNow());
            }

            return user.Id;
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            lock (_lock)
            {
                _cache.Remove(email);
            }

            return await FindIdByEmailAsync(email, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("could not create user {Email}: {Error}", email, ex.Message);
            return null;
        }
    }
}
