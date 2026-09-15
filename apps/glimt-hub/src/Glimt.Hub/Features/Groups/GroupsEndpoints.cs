using System.Security.Claims;
using Glimt.Hub.Features.Auth;
using Glimt.Hub.Features.Demo;
using Glimt.Hub.Infrastructure;
using Glimt.Hub.Infrastructure.Access;
using Glimt.Hub.Infrastructure.Auth;

namespace Glimt.Hub.Features.Groups;

public sealed record GroupDto(string Id, string Name, IReadOnlyList<string> MemberIds, int Order, DateTimeOffset CreatedAt)
{
    /// <summary>The group as the owner sees it: members they no longer can read are left out (the document is not changed).</summary>
    public static GroupDto From(GroupDocument group, IReadOnlySet<string> visible) =>
        new(group.Id, group.Name, group.MemberIds.Where(visible.Contains).ToList(), group.Order, new DateTimeOffset(DateTime.SpecifyKind(group.CreatedAt, DateTimeKind.Utc)));
}

public sealed record CreateGroupRequest(string? Name, List<string>? MemberIds);

/// <summary>Every field optional; null = unchanged.</summary>
public sealed record PatchGroupRequest(string? Name, List<string>? MemberIds, int? Order);

/// <summary>
/// /api/groups (IMPLEMENTERINGSPLAN step 13.1): the user's own named groups of nodes. Members are validated against
/// <see cref="IAccessService.CanReadAsync"/> when written and filtered by what the user still sees when read. No
/// SignalR messages: the group card is computed in the browser from the Cards. The demo account can read, not write.
/// </summary>
public static class GroupsEndpoints
{
    public static IEndpointRouteBuilder MapGroupsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/groups")
            .RequireAuthorization()
            .RequireRateLimiting(RateLimiting.ApiPolicy)
            .AddEndpointFilter<RequireDatabase>();
        group.MapGet("", ListAsync);
        group.MapPost("", CreateAsync);
        group.MapPatch("/{id}", PatchAsync);
        group.MapDelete("/{id}", DeleteAsync);
        return app;
    }

    private static async Task<IResult> ListAsync(ClaimsPrincipal principal, GroupStore groups, IAccessService access, CancellationToken cancellationToken)
    {
        var userId = principal.RequireUserId();
        var list = await groups.ListByOwnerAsync(userId, cancellationToken);
        var visible = (await access.VisibleServerIdsAsync(userId, cancellationToken)).ToHashSet(StringComparer.Ordinal);
        return Results.Ok(list.Select(g => GroupDto.From(g, visible)).ToList());
    }

    private static async Task<IResult> CreateAsync(
        CreateGroupRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        GroupStore groups,
        IAccessService access,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var userId = principal.RequireUserId();
        if (await DemoReadOnlyAsync(userId, users, cancellationToken) is { } readOnly)
        {
            return readOnly;
        }

        var name = Validation.NormalizeName(request.Name, GroupDocument.NameMaxLength);
        if (name is null)
        {
            return Validation.ValidationProblem("name", $"Name must be 1–{GroupDocument.NameMaxLength} characters.");
        }

        var members = await ValidateMembersAsync(request.MemberIds ?? [], userId, access, cancellationToken);
        if (members.Error is not null)
        {
            return members.Error;
        }

        var count = await groups.CountByOwnerAsync(userId, cancellationToken);
        if (count >= GroupDocument.MaxPerUser)
        {
            return Validation.ValidationProblem("name", $"At most {GroupDocument.MaxPerUser} groups.");
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var doc = new GroupDocument { OwnerId = userId, Name = name, MemberIds = members.Ids!, Order = (int)count, CreatedAt = now, UpdatedAt = now };
        await groups.InsertAsync(doc, cancellationToken);
        return Results.Created($"/api/groups/{doc.Id}", GroupDto.From(doc, members.Ids!.ToHashSet(StringComparer.Ordinal)));
    }

    private static async Task<IResult> PatchAsync(
        string id,
        PatchGroupRequest request,
        ClaimsPrincipal principal,
        UserStore users,
        GroupStore groups,
        IAccessService access,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var userId = principal.RequireUserId();
        if (await DemoReadOnlyAsync(userId, users, cancellationToken) is { } readOnly)
        {
            return readOnly;
        }

        var doc = await groups.FindAsync(id, cancellationToken);
        if (doc is null)
        {
            return Validation.NotFound("Group not found");
        }

        if (doc.OwnerId != userId)
        {
            return Validation.Forbidden("Not your group");
        }

        if (request.Name is not null)
        {
            var name = Validation.NormalizeName(request.Name, GroupDocument.NameMaxLength);
            if (name is null)
            {
                return Validation.ValidationProblem("name", $"Name must be 1–{GroupDocument.NameMaxLength} characters.");
            }

            doc.Name = name;
        }

        if (request.MemberIds is not null)
        {
            var members = await ValidateMembersAsync(request.MemberIds, userId, access, cancellationToken);
            if (members.Error is not null)
            {
                return members.Error;
            }

            doc.MemberIds = members.Ids!;
        }

        if (request.Order is { } order)
        {
            doc.Order = Math.Max(0, order);
        }

        doc.UpdatedAt = clock.GetUtcNow().UtcDateTime;
        if (await groups.ReplaceAsync(doc, cancellationToken) is null)
        {
            return Validation.NotFound("Group not found");
        }

        var visible = (await access.VisibleServerIdsAsync(userId, cancellationToken)).ToHashSet(StringComparer.Ordinal);
        return Results.Ok(GroupDto.From(doc, visible));
    }

    private static async Task<IResult> DeleteAsync(string id, ClaimsPrincipal principal, UserStore users, GroupStore groups, CancellationToken cancellationToken)
    {
        var userId = principal.RequireUserId();
        if (await DemoReadOnlyAsync(userId, users, cancellationToken) is { } readOnly)
        {
            return readOnly;
        }

        var doc = await groups.FindAsync(id, cancellationToken);
        if (doc is null)
        {
            return Validation.NotFound("Group not found");
        }

        if (doc.OwnerId != userId)
        {
            return Validation.Forbidden("Not your group");
        }

        await groups.DeleteAsync(userId, id, cancellationToken);
        return Results.NoContent();
    }

    /// <summary>1–40 characters after trimming, single spaces inside.</summary>
    /// <summary>Distinct ids, at most 100, each readable by the user (own or granted).</summary>
    private static async Task<(List<string>? Ids, IResult? Error)> ValidateMembersAsync(IEnumerable<string?> memberIds, string userId, IAccessService access, CancellationToken cancellationToken)
    {
        var ids = memberIds.Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id!.Trim()).Distinct(StringComparer.Ordinal).ToList();
        if (ids.Count > GroupDocument.MaxMembers)
        {
            return (null, Validation.ValidationProblem("memberIds", $"At most {GroupDocument.MaxMembers} nodes in a group."));
        }

        foreach (var id in ids)
        {
            if (!await access.CanReadAsync(userId, id, cancellationToken))
            {
                return (null, Validation.ValidationProblem("memberIds", $"No access to node '{id}'."));
            }
        }

        return (ids, null);
    }

    /// <summary>The demo account (demo@glimtpanel.com) may look at its groups, never change them.</summary>
    private static async Task<IResult?> DemoReadOnlyAsync(string userId, UserStore users, CancellationToken cancellationToken)
    {
        var user = await users.FindByIdAsync(userId, cancellationToken);
        return user is not null && string.Equals(user.Email, DemoData.DemoUserEmail, StringComparison.OrdinalIgnoreCase)
            ? Validation.Forbidden("The demo account cannot change groups")
            : null;
    }
}
