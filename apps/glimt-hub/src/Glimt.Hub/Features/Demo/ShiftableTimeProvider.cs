namespace Glimt.Hub.Features.Demo;

/// <summary>
/// The e2e clock: the system clock plus an offset that POST /api/e2e/advance grows. Timers keep running
/// on real time, so callers that need "now" after a jump run their sweep explicitly (DownDetector).
/// Note: access tokens are validated with the real clock by the JWT middleware, so a token issued after
/// a large advance is "not yet valid" until real time catches up (30 s skew allowed).
/// </summary>
public sealed class ShiftableTimeProvider : TimeProvider
{
    private long _offsetTicks;

    public TimeSpan Offset => TimeSpan.FromTicks(Interlocked.Read(ref _offsetTicks));

    public override DateTimeOffset GetUtcNow() => base.GetUtcNow() + Offset;

    public void Advance(TimeSpan by) => Interlocked.Add(ref _offsetTicks, by.Ticks);
}
