import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { ownerAction } from "./lib/functions";
import { reserveSpend } from "./lib/placesBudget";
import { writePlace, type PlaceRecord } from "./lib/places";
import { searchPlaces } from "./lib/placesApi";
import type { Id } from "./_generated/dataModel";

/**
 * SOURCING: A LOOP OVER A PAID API, WITH THE RAILS ALREADY BUILT.
 *
 * The spend ledger, the 30-day cache and the guards that hold both were
 * written before this — deliberately, because a sourcing run is the thing
 * they exist to survive. A bug in this loop is not a crash, it is an invoice,
 * and it is spent before anybody notices.
 *
 * THE ORDER IS THE WHOLE DESIGN:
 *
 *   1. CHARGE, in its own transaction, through `reserveSpend`. It refuses
 *      when the month's cap is reached and refuses again when no cap is set
 *      at all — there is no unlimited mode.
 *   2. CALL Google. The charge has already committed and there is no refund
 *      path, which is the direction to be wrong in: over-counting refuses a
 *      call we could have afforded and is fixed by raising the cap;
 *      under-counting spends past it and that money is gone.
 *   3. CACHE what came back, through `writePlace`, which computes the expiry
 *      itself so no call site can choose "never".
 *   4. IMPORT, through the existing `importLeads`, which dedupes and writes
 *      the provenance.
 *
 * AN ACTION, because step 2 is network I/O and an action has no transaction.
 * Each step above is its own mutation for exactly that reason, and the run is
 * therefore NOT atomic — a crash between 2 and 3 has spent money and cached
 * nothing. That is recoverable (search again) and the alternative is not
 * (spend nothing and have no record of the spend).
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

/** The operation name the cap prices. `spendCaps.unitCostCents.textSearch`. */
const OPERATION = "textSearch";

export const chargeForSearch = internalMutation({
  args: { at: v.number(), runId: v.string() },
  handler: (ctx, args) =>
    reserveSpend(ctx, {
      provider: "google_places",
      operation: OPERATION,
      units: 1,
      at: args.at,
      runId: args.runId,
    }),
});

export const cachePlaces = internalMutation({
  args: { places: v.any(), now: v.number() },
  handler: async (ctx, args) => {
    for (const place of args.places as PlaceRecord[]) {
      await writePlace(ctx, place, args.now);
    }
  },
});

/**
 * Run a search and turn the results into leads.
 *
 * OWNER-GATED, because it spends money. The cap makes a mistake survivable;
 * this makes it deliberate.
 */
export const run = ownerAction({
  args: {
    ventureId: v.id("ventures"),
    niche: v.string(),
    /** What to search for, in Google's words: "solar installers in Ballito". */
    textQuery: v.string(),
    /**
     * PAGES, NOT RESULTS, because a page is what gets billed. Naming the unit
     * the ledger charges for is what stops "give me 200" reading as one call.
     */
    maxPages: v.optional(v.number()),
    lawfulBasis: v.union(v.literal("consent"), v.literal("legitimate_interest")),
    now: v.optional(v.number()),
  },
  /*
   * THE RETURN TYPE IS WRITTEN OUT, and it has to be.
   *
   * This handler calls `internal.sourcing.*` — its own module — so inferring
   * its type requires the module's type, which requires this handler's type.
   * TypeScript resolves that cycle by giving up and returning `any`, and the
   * `any` does not stay here: it propagates through the generated API and
   * every consumer of it. Removing this annotation produced 117 errors across
   * 20 files, none of them in this one, all of them reading as unrelated
   * "implicitly has an any type" in screens that had not changed.
   */
  handler: async (
    ctx,
    args,
  ): Promise<{
    created: number;
    skipped: number;
    withoutPhone: number;
    unusable: string[];
    pagesFetched: number;
    found: number;
    stoppedBecause: "done" | "spend cap" | "page limit";
    spentCents: number;
  }> => {
    const now = args.now ?? Date.now();
    const textQuery = args.textQuery.trim();
    if (!textQuery) throw bad("INVALID", "A search needs something to search for.");

    /*
     * A MISSING KEY IS A REFUSAL, not a skip. Same shape as a missing webhook
     * secret and a missing spend cap: an unconfigured deployment that appears
     * to work is the failure these rules exist to prevent.
     */
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw bad(
        "NO_PLACES_KEY",
        "GOOGLE_PLACES_API_KEY is not set on this deployment. Sourcing will not run without it.",
      );
    }

    /*
     * Bounded here AND by the ledger, and the two are not redundant. This
     * stops a typo asking for a thousand pages; the ledger stops the month
     * costing more than it should whatever any single run asks for. It is a
     * page count rather than a spend limit, which is why it is not the
     * hard-coded cap the guard forbids.
     */
    const pageLimit = Math.max(1, Math.min(args.maxPages ?? 1, 10));
    const runId = `places-${now}`;

    const collected: PlaceRecord[] = [];
    let pageToken: string | undefined;
    let pagesFetched = 0;
    let stoppedBecause: "done" | "spend cap" | "page limit" = "done";
    let spentCents = 0;

    for (let page = 0; page < pageLimit; page += 1) {
      /*
       * CHARGED BEFORE THE CALL. If this throws SPEND_CAP the loop stops —
       * it never retries, because a retry after a refusal is how a cap turns
       * into a suggestion. What was already fetched is still imported below:
       * throwing away pages we have paid for helps nobody.
       */
      try {
        const charge = await ctx.runMutation(internal.sourcing.chargeForSearch, {
          at: now,
          runId,
        });
        spentCents = charge.spentCents;
      } catch (error) {
        const code =
          error && typeof error === "object" && "data" in error
            ? (error.data as { code?: string })?.code
            : undefined;
        if (code === "SPEND_CAP") {
          stoppedBecause = "spend cap";
          break;
        }
        throw error;
      }

      const result = await searchPlaces({ apiKey, textQuery, pageToken });
      pagesFetched += 1;
      collected.push(...result.places);

      if (!result.nextPageToken) break;
      pageToken = result.nextPageToken;
      if (page === pageLimit - 1) stoppedBecause = "page limit";
    }

    if (collected.length > 0) {
      await ctx.runMutation(internal.sourcing.cachePlaces, { places: collected, now });
    }

    /*
     * THROUGH THE SAME IMPORT AS A PASTED LIST, so dedupe, phone
     * normalisation and provenance are one implementation rather than two.
     * A second import path is a second opinion about which businesses are
     * already here.
     */
    const imported = await ctx.runMutation(internal.leadImport.importLeads, {
      ventureId: args.ventureId as Id<"ventures">,
      niche: args.niche.trim(),
      source: "places" as const,
      lawfulBasis: args.lawfulBasis,
      /*
       * NOW, and legitimately so: unlike a directory list pulled last week,
       * this data was captured by this call. `capturedAt` is when the pull
       * happened, and the pull is happening.
       */
      capturedAt: now,
      rows: collected.map((place) => ({
        businessName: place.displayName ?? place.placeId,
        phone: place.phone,
        website: place.website,
        /*
         * The formatted address, kept as the area. It is what Google
         * returned and it is what a demo needs to say where they work —
         * and it is Maps Content, which is why the cache row beside it
         * expires while this one does not. The lead holds what a person
         * could have read off the business's own signage; the licensed
         * copy lives in placesCache with its clock.
         */
        area: place.formattedAddress,
        placeId: place.placeId,
        detail: `Google Places search: ${textQuery}`,
      })),
    });

    return {
      ...imported,
      pagesFetched,
      found: collected.length,
      stoppedBecause,
      spentCents,
    };
  },
});
