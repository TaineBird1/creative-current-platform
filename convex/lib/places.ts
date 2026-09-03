import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { replaceDoc } from "./db";

/**
 * WHAT GOOGLE LETS US KEEP, ENFORCED IN CODE.
 *
 * From the Places API policies and the Maps Platform Service Specific Terms,
 * as they read when this was written (checked, not remembered):
 *
 *   `place_id` is EXEMPT from the caching restriction and may be stored
 *   indefinitely. It is the only field here that may outlive its row.
 *
 *   Everything else the API returns — display name, formatted address, phone,
 *   website, rating, review count — is Google Maps Content under a temporary
 *   caching allowance. The limit is 30 consecutive calendar days.
 *
 *   Anything DISPLAYED from it carries attribution: the "Google Maps" name
 *   rather than a bare "Powered by Google", the third-party attributions the
 *   response returned, and a link to the source on Google Maps for reviews
 *   and photos. Reviews are shown as returned, not edited.
 *
 * So the expiry is a column and the reader refuses past it. An expiry
 * implemented as a nightly cleanup job is an expiry that silently lapses the
 * night the job fails, and what is left is a database of somebody else's
 * content that we are not licensed to hold.
 *
 * The refusal is deliberately not "return it and let the caller decide". A
 * caller that has the data in its hand will use it, and the failure — serving
 * a two-month-old rating as current — is invisible to everyone except the
 * business whose rating moved.
 */

/** 30 consecutive calendar days, per the terms. Not a tuning knob. */
export const PLACES_CACHE_MS = 30 * 24 * 60 * 60 * 1000;

export type PlaceRecord = {
  placeId: string;
  displayName?: string;
  formattedAddress?: string;
  phone?: string;
  website?: string;
  rating?: number;
  reviewCount?: number;
  attributionHtml: string[];
  googleMapsUri?: string;
};

/**
 * Read a cached place, or null when there is nothing usable.
 *
 * Null covers both "never fetched" and "too old to hold", and the caller
 * cannot tell them apart on purpose — the correct response to either is to
 * fetch again or to do without, never to reach past this function.
 */
export async function readPlace(
  ctx: QueryCtx,
  placeId: string,
  now: number,
): Promise<PlaceRecord | null> {
  const row = await ctx.db
    .query("placesCache")
    .withIndex("by_placeId", (q) => q.eq("placeId", placeId))
    .unique();

  if (!row) return null;
  if (row.expiresAt <= now) return null;

  return {
    placeId: row.placeId,
    displayName: row.displayName,
    formattedAddress: row.formattedAddress,
    phone: row.phone,
    website: row.website,
    rating: row.rating,
    reviewCount: row.reviewCount,
    attributionHtml: row.attributionHtml,
    googleMapsUri: row.googleMapsUri,
  };
}

/**
 * Store a freshly fetched place. The ONLY writer of `placesCache`.
 *
 * `expiresAt` is computed here rather than accepted from the caller: a caller
 * that can choose its own expiry can choose "never", and the whole point is
 * that nobody gets to make that decision per call site.
 */
export async function writePlace(
  ctx: MutationCtx,
  record: PlaceRecord,
  now: number,
): Promise<void> {
  if (!record.placeId) {
    throw new ConvexError({ code: "INVALID", message: "a cached place needs its placeId" });
  }

  /*
   * A rating shown without its attribution is the breach that happens by
   * omission rather than by intent, so the two cannot be stored apart. If
   * the response carried no attributions the array is empty and that is
   * fine; what is refused is losing them somewhere between fetch and write.
   */
  const row = {
    ...record,
    attributionHtml: record.attributionHtml ?? [],
    fetchedAt: now,
    expiresAt: now + PLACES_CACHE_MS,
  };

  const existing = await ctx.db
    .query("placesCache")
    .withIndex("by_placeId", (q) => q.eq("placeId", record.placeId))
    .unique();

  if (existing) {
    // A refresh resets the clock, which is what a re-fetch is for. It does
    // not extend the old row's licence — the row is replaced wholesale.
    await replaceDoc(ctx, existing._id, row);
    return;
  }
  await ctx.db.insert("placesCache", row);
}

/**
 * Rows past their limit, for the sweeper.
 *
 * The sweeper is housekeeping, NOT the enforcement — `readPlace` already
 * refuses expired rows, so a sweeper that never runs costs disk rather than
 * compliance. That ordering is deliberate: enforcement that depends on a cron
 * is enforcement that lapses the first night the cron fails.
 */
export async function expiredPlaces(ctx: QueryCtx, now: number, limit = 200) {
  return ctx.db
    .query("placesCache")
    .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
    .take(limit);
}

/**
 * The attribution that must accompany anything rendered from a place.
 *
 * Returned as data rather than left to each surface to remember, because "the
 * demo template forgot the attribution line" is not a visual bug — it is
 * using someone's licensed content outside the licence.
 */
export function attributionFor(record: PlaceRecord) {
  return {
    /** The terms ask for the Google Maps name, not a bare "Powered by Google". */
    source: "Google Maps" as const,
    thirdParty: record.attributionHtml,
    /** Where a reader goes to see the original. Required for reviews and photos. */
    href: record.googleMapsUri ?? null,
  };
}
