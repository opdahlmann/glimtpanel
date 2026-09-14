using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using MongoDB.Driver;

namespace Glimt.Hub.Features.Auth;

/// <summary>The part of the user store the alert dispatcher needs (faked in tests).</summary>
public interface IUserLookup
{
    Task<IReadOnlyList<UserDocument>> FindByIdsAsync(IEnumerable<string> ids, CancellationToken cancellationToken);
}

/// <summary>Persistence for `users` and the `counters` sequence. Callers guard with <see cref="RequireDatabase"/>.</summary>
public sealed class UserStore(MongoContext mongo) : IUserLookup
{
    public const int EarlyAdopterLimit = 100;

    private IMongoCollection<UserDocument> Users => mongo.Db.GetCollection<UserDocument>(UserDocument.Collection);
    private IMongoCollection<CounterDocument> Counters => mongo.Db.GetCollection<CounterDocument>(CounterDocument.Collection);

    public Task<UserDocument?> FindByIdAsync(string id, CancellationToken cancellationToken) =>
        Users.Find(u => u.Id == id).FirstOrDefaultAsync(cancellationToken)!;

    public Task<UserDocument?> FindByEmailAsync(string email, CancellationToken cancellationToken) =>
        Users.Find(u => u.Email == email).FirstOrDefaultAsync(cancellationToken)!;

    public async Task<IReadOnlyList<UserDocument>> FindByIdsAsync(IEnumerable<string> ids, CancellationToken cancellationToken)
    {
        var list = ids.Distinct().ToList();
        if (list.Count == 0)
        {
            return [];
        }

        return await Users.Find(Builders<UserDocument>.Filter.In(u => u.Id, list)).ToListAsync(cancellationToken);
    }

    /// <summary>Every user (id, e-mail, name, zone, language); the digest walks this once a minute.</summary>
    public async Task<IReadOnlyList<UserDocument>> ListAsync(CancellationToken cancellationToken) =>
        mongo.IsAvailable ? await Users.Find(FilterDefinition<UserDocument>.Empty).ToListAsync(cancellationToken) : [];

    /// <summary>Next value of the "users" sequence (1 for the first account ever created).</summary>
    public async Task<long> NextUserNumberAsync(CancellationToken cancellationToken)
    {
        var counter = await Counters.FindOneAndUpdateAsync(
            c => c.Id == CounterDocument.Users,
            Builders<CounterDocument>.Update.Inc(c => c.Seq, 1),
            new FindOneAndUpdateOptions<CounterDocument> { IsUpsert = true, ReturnDocument = ReturnDocument.After },
            cancellationToken);
        return counter.Seq;
    }

    /// <summary>Inserts the user. Returns false when the e-mail is already taken.</summary>
    public async Task<bool> TryInsertAsync(UserDocument user, CancellationToken cancellationToken)
    {
        try
        {
            await Users.InsertOneAsync(user, cancellationToken: cancellationToken);
            return true;
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            return false;
        }
    }

    /// <summary>Sets emailConfirmedAt when it is still null; returns true when the user exists.</summary>
    public async Task<bool> ConfirmEmailAsync(string userId, DateTime now, CancellationToken cancellationToken)
    {
        var result = await Users.UpdateOneAsync(
            u => u.Id == userId && u.EmailConfirmedAt == null,
            Builders<UserDocument>.Update.Set(u => u.EmailConfirmedAt, now),
            cancellationToken: cancellationToken);
        return result.MatchedCount > 0 || await Users.Find(u => u.Id == userId).AnyAsync(cancellationToken);
    }

    public async Task<bool> SetPasswordHashAsync(string userId, string passwordHash, bool confirmEmail, DateTime now, CancellationToken cancellationToken)
    {
        var update = Builders<UserDocument>.Update.Set(u => u.PasswordHash, passwordHash);
        var result = await Users.UpdateOneAsync(u => u.Id == userId, update, cancellationToken: cancellationToken);
        if (confirmEmail)
        {
            await ConfirmEmailAsync(userId, now, cancellationToken);
        }

        return result.MatchedCount > 0;
    }

    public async Task<UserDocument?> UpdateProfileAsync(string userId, string? name, string? timezone, string? language, CancellationToken cancellationToken)
    {
        var updates = new List<UpdateDefinition<UserDocument>>();
        if (name is not null)
        {
            updates.Add(Builders<UserDocument>.Update.Set(u => u.Name, name));
        }

        if (timezone is not null)
        {
            updates.Add(Builders<UserDocument>.Update.Set(u => u.Timezone, timezone));
        }

        if (language is not null)
        {
            updates.Add(Builders<UserDocument>.Update.Set(u => u.Language, language));
        }

        if (updates.Count == 0)
        {
            return await FindByIdAsync(userId, cancellationToken);
        }

        return await Users.FindOneAndUpdateAsync(
            u => u.Id == userId,
            Builders<UserDocument>.Update.Combine(updates),
            new FindOneAndUpdateOptions<UserDocument> { ReturnDocument = ReturnDocument.After },
            cancellationToken);
    }

    /// <summary>Sets a new (already confirmed) e-mail; false when another account has it (unique index).</summary>
    public async Task<bool> UpdateEmailAsync(string userId, string email, DateTime now, CancellationToken cancellationToken)
    {
        try
        {
            var result = await Users.UpdateOneAsync(
                u => u.Id == userId,
                Builders<UserDocument>.Update.Set(u => u.Email, email).Set(u => u.EmailConfirmedAt, now),
                cancellationToken: cancellationToken);
            return result.MatchedCount > 0;
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            return false;
        }
    }

    public async Task<bool> DeleteAsync(string userId, CancellationToken cancellationToken)
    {
        var result = await Users.DeleteOneAsync(u => u.Id == userId, cancellationToken);
        return result.DeletedCount > 0;
    }
}
