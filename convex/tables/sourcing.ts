import { defineTable } from "convex/server";
import { v } from "convex/values";
import { currency } from "./tenants";

/**
 * LEAD SOURCING: WHAT IT COSTS, AND WHAT WE ARE ALLOWED TO KEEP.
 *
 * Two separate problems, both of which fail quietly.
 *
 * THE SPEND. A sourcing run is a loop over a paid API. A bug in the loop is
 * not a crash, it is an invoice — and by the time anyone notices, the money
 * is spent. So the cap is a LEDGER the run writes to and checks, not a
 * constant somebody remembered to compare against. Same shape as the
 * demo/seed block in dispatch: one choke point, one guard test, no caller
 * that can forget.
 *
 * THE DATA. Google's Places terms do not let us keep what the API returns.
 * `place_id` is explicitly exempt and may be stored indefinitely; everything
 * else — the name, the rating, the review count, the phone number — is
 * Google Maps Content under a temporary-caching allowance, capped at 30
 * consecutive calendar days, and it carries attribution requirements when
 * displayed. So the cache has an expiry in the schema rather than a policy
 * in a comment, and the reader refuses stale rows instead of serving them.
 *
 * That is also why `provenance` exists on the lead: a phone number a human
 * typed off the business's own website is not Google Maps Content and does
 * not expire. Recording where each field came from is what makes the
 * distinction enforceable instead of a matter of memory.
 */
export const sourcingTables = {
  /**
   * APPEND-ONLY SPEND LEDGER. Written by lib/placesBudget.ts and nothing else.
   *
   * Recorded BEFORE the call it pays for, never after. The two failures cost
   * differently: over-counting refuses a call we could have afforded, which
   * is recoverable by raising the cap; under-counting spends past the cap,
   * and that money is gone. A crash between the reservation and the request
   * therefore leaves a charge for a call that never happened, and that is the
   * side to err on. There is deliberately no refund path — a refund is how a
   * retry loop turns a cap into a suggestion.
   */
  apiSpend: defineTable({
    provider: v.union(v.literal("google_places"), v.literal("google_geocoding")),
    /** The billing SKU, because they are not priced alike. */
    operation: v.string(),
    units: v.number(),
    costCents: v.number(),
    currency,
    at: v.number(),
    /** The sourcing run this belonged to, so a runaway loop is attributable. */
    runId: v.optional(v.string()),
    note: v.optional(v.string()),
  })
    .index("by_provider_at", ["provider", "at"])
    .index("by_run", ["runId"]),

  /**
   * THE CAP, AS DATA.
   *
   * A row, not a constant: a constant is edited in a deploy, and the point of
   * a cap is that it is visible and adjustable by the person paying the bill.
   * One row per (provider, period).
   */
  spendCaps: defineTable({
    provider: v.union(v.literal("google_places"), v.literal("google_geocoding")),
    /** "2026-08" — the calendar month the cap applies to. */
    period: v.string(),
    capCents: v.number(),
    currency,
    /** Per-SKU unit price, so the ledger can cost a call without guessing. */
    unitCostCents: v.record(v.string(), v.number()),
    updatedAt: v.number(),
  }).index("by_provider_period", ["provider", "period"]),

  /**
   * PLACES CACHE, WITH THE EXPIRY IN THE SCHEMA.
   *
   * `placeId` is the exempt field and is the key. Everything beside it is
   * Google Maps Content on a 30-day clock, and `expiresAt` is not advisory:
   * lib/places.ts refuses to return a row past it, which is the difference
   * between an expiry and a comment about one.
   *
   * `attributionHtml` and `googleMapsUri` are stored because they are not
   * optional extras — displaying a rating without the attribution the API
   * returned is the part of the terms that is easiest to breach by omission,
   * so the fields travel with the data that requires them.
   */
  placesCache: defineTable({
    /** Exempt from the caching limit. The only field that may outlive the row. */
    placeId: v.string(),
    displayName: v.optional(v.string()),
    formattedAddress: v.optional(v.string()),
    phone: v.optional(v.string()),
    website: v.optional(v.string()),
    rating: v.optional(v.number()),
    reviewCount: v.optional(v.number()),
    /** Returned by the API and REQUIRED beside anything rendered from it. */
    attributionHtml: v.array(v.string()),
    googleMapsUri: v.optional(v.string()),
    fetchedAt: v.number(),
    /** fetchedAt + 30 days. Enforced on read, not by a cleanup job we forgot. */
    expiresAt: v.number(),
  })
    .index("by_placeId", ["placeId"])
    .index("by_expiresAt", ["expiresAt"]),
};
