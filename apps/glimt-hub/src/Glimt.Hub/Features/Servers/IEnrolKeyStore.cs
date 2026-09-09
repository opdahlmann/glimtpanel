namespace Glimt.Hub.Features.Servers;

/// <summary>What a consumed one-time key tells the agent authenticator (step 2.4).</summary>
public sealed record EnrolKeyInfo(string OwnerId, string DockerMode);

/// <summary>
/// One-time enrol keys (`gp_…`, TTL 1 hour, collection enrolKeys). Created by POST /api/servers/enrol-key,
/// consumed exactly once by the agent's hello. Implemented in the Servers feature; used by Agents.
/// </summary>
public interface IEnrolKeyStore
{
    /// <summary>Returns the key info and marks it used, or null when unknown, expired or already used.</summary>
    Task<EnrolKeyInfo?> TryConsumeAsync(string key, CancellationToken cancellationToken);
}

internal sealed class NullEnrolKeyStore : IEnrolKeyStore
{
    public Task<EnrolKeyInfo?> TryConsumeAsync(string key, CancellationToken cancellationToken) => Task.FromResult<EnrolKeyInfo?>(null);
}
