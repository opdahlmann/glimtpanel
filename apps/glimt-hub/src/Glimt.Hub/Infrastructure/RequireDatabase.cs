namespace Glimt.Hub.Infrastructure;

/// <summary>
/// Endpoint filter for everything that needs MongoDB: answers 503 instead of letting the driver time out
/// while the hub runs without a database (see <see cref="MongoContext"/>).
/// </summary>
public sealed class RequireDatabase(MongoContext mongo) : IEndpointFilter
{
    public ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        if (!mongo.IsAvailable)
        {
            return ValueTask.FromResult<object?>(Results.Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Database unavailable",
                detail: mongo.UnavailableReason));
        }

        return next(context);
    }
}
