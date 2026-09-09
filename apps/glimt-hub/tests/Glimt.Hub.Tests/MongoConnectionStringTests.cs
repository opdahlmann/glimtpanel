using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Tests;

public class MongoConnectionStringTests
{
    [Theory]
    [InlineData("mongodb://u:p@h:27017/admin?authMechanism=DEFAULT&authSource=admin&directConnection=true", "mongodb://u:p@h:27017/admin?authSource=admin&directConnection=true")]
    [InlineData("mongodb://u:p@h:27017/?authSource=admin&authMechanism=DEFAULT", "mongodb://u:p@h:27017/?authSource=admin")]
    [InlineData("mongodb://u:p@h:27017/?authMechanism=DEFAULT", "mongodb://u:p@h:27017/")]
    [InlineData("mongodb://u:p@h:27017/?authSource=admin", "mongodb://u:p@h:27017/?authSource=admin")]
    public void Removes_authMechanism_default_only(string input, string expected)
    {
        Assert.Equal(expected, MongoContext.NormalizeConnectionString(input));
    }
}
