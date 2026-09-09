namespace Glimt.Hub.Features.Account;

/// <summary>GET /api/subscription (IMPLEMENTERINGSPLAN step 2.3). Beta has no server limit; the slot model only counts.</summary>
public sealed record SubscriptionDto(
    int SlotsUsed,
    int SlotsFree,
    int SlotsBeta,
    string Plan,
    int PlannedPricePerSlotUsd,
    int DiscountPct,
    int WouldCostUsd,
    int WouldCostWithDiscountUsd,
    int NoticeDays);

public static class Subscription
{
    public const int FreeSlots = 2;
    public const int PlannedPricePerSlotUsd = 12;
    public const int EarlyAdopterDiscountPct = 50;
    public const int NoticeDays = 60;

    public static SubscriptionDto Compute(int slotsUsed, bool earlyAdopter, string plan)
    {
        var beta = Math.Max(0, slotsUsed - FreeSlots);
        var discount = earlyAdopter ? EarlyAdopterDiscountPct : 0;
        var wouldCost = beta * PlannedPricePerSlotUsd;
        return new SubscriptionDto(
            slotsUsed,
            FreeSlots,
            beta,
            plan,
            PlannedPricePerSlotUsd,
            discount,
            wouldCost,
            wouldCost * (100 - discount) / 100,
            NoticeDays);
    }
}
