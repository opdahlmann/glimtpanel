using Glimt.Hub.Infrastructure;

namespace Glimt.Hub.Tests;

public sealed class PasswordHasherTests
{
    [Fact]
    public void Round_trip_verifies_and_rejects_wrong_password()
    {
        var encoded = PasswordHasher.Hash("GlimtDev-2026!");

        Assert.StartsWith("$argon2id$v=19$m=65536,t=3,p=1$", encoded);
        Assert.True(PasswordHasher.Verify("GlimtDev-2026!", encoded));
        Assert.False(PasswordHasher.Verify("GlimtDev-2026", encoded));
        Assert.False(PasswordHasher.Verify("", encoded));
    }

    [Fact]
    public void Same_password_gets_a_different_salt()
    {
        Assert.NotEqual(PasswordHasher.Hash("secret"), PasswordHasher.Hash("secret"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-hash")]
    [InlineData("$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA")]
    [InlineData("$argon2id$v=19$m=0,t=3,p=1$c2FsdA$aGFzaA")]
    [InlineData("$argon2id$v=19$m=65536,t=3,p=1$!!!$aGFzaA")]
    public void Malformed_hashes_never_verify(string encoded)
    {
        Assert.False(PasswordHasher.Verify("secret", encoded));
    }
}
