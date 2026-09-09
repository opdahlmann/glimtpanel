using System.Net.Http.Json;
using Glimt.Hub.Features.Servers;
using Glimt.Hub.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;

namespace Glimt.Hub.Tests;

/// <summary>Proves the Testcontainers fixture: the hub connects, creates indexes and seeds the dev user.</summary>
public class MongoHubTests
{
    [Fact]
    public async Task Hub_connects_to_mongo_and_seeds_dev_user()
    {
        using var factory = HubFactory.WithMongo();
        using var client = factory.CreateClient();
        var mongo = factory.Services.GetRequiredService<MongoContext>();

        Assert.True(await mongo.Ready.WaitAsync(TimeSpan.FromSeconds(20)), "mongo should be reachable");

        var health = await client.GetFromJsonAsync<Dictionary<string, object>>("/healthz");
        Assert.Equal("ok", health!["mongo"].ToString());

        var users = mongo.Db.GetCollection<UserDocument>(UserDocument.Collection);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        UserDocument? dev = null;
        while (dev is null && DateTime.UtcNow < deadline)
        {
            dev = await users.Find(u => u.Email == "dev@glimtpanel.local").FirstOrDefaultAsync();
            if (dev is null)
            {
                await Task.Delay(200);
            }
        }

        Assert.NotNull(dev);
        Assert.NotNull(dev.EmailConfirmedAt);
        Assert.Equal("beta", dev.Plan);
    }
}
