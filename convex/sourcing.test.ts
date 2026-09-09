import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { mapPlacesResponse } from "./lib/placesApi";
import { periodFor } from "./lib/placesBudget";
import { readPlace, PLACES_CACHE_MS } from "./lib/places";

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);

/**
 * SOURCING SPENDS MONEY, so the tests are about the two things that cost:
 * charging before the call, and never holding content longer than the licence
 * allows. The fetch itself is not mocked here — `mapPlacesResponse` is pure
 * and is where the mistakes actually live.
 */

const AUG = Date.UTC(2026, 7, 15);

async function withCap(h: ReturnType<typeof harness>, capCents: number) {
  await h.run((ctx) =>
    ctx.db.insert("spendCaps", {
      provider: "google_places",
      period: periodFor(AUG),
      capCents,
      currency: "ZAR",
      unitCostCents: { textSearch: 60 },
      updatedAt: AUG,
    }),
  );
}

describe("the response is mapped defensively", () => {
  test("a full place comes through", () => {
    const page = mapPlacesResponse({
      places: [
        {
          id: "ChIJabc",
          displayName: { text: "Renu Solar" },
          formattedAddress: "12 Old Main Rd, Hillcrest",
          nationalPhoneNumber: "031 555 1234",
          websiteUri: "https://renusolar.co.za",
          googleMapsUri: "https://maps.google.com/?cid=1",
          attributions: [{ provider: "Listing by SolarZA" }],
        },
      ],
      nextPageToken: "tok",
    });

    expect(page.places[0]).toEqual({
      placeId: "ChIJabc",
      displayName: "Renu Solar",
      formattedAddress: "12 Old Main Rd, Hillcrest",
      phone: "031 555 1234",
      website: "https://renusolar.co.za",
      googleMapsUri: "https://maps.google.com/?cid=1",
      attributionHtml: ["Listing by SolarZA"],
    });
    expect(page.nextPageToken).toBe("tok");
  });

  /**
   * THE NORMAL CASE, not an error. A business with no website is exactly the
   * business this whole engine is looking for, so a mapper that assumed one
   * would drop the best leads.
   */
  test("a business with no website and no phone still maps", () => {
    const page = mapPlacesResponse({
      places: [{ id: "ChIJxyz", displayName: { text: "Alpha Power" } }],
    });
    expect(page.places[0]).toEqual({
      placeId: "ChIJxyz",
      displayName: "Alpha Power",
      formattedAddress: undefined,
      phone: undefined,
      website: undefined,
      googleMapsUri: undefined,
      attributionHtml: [],
    });
  });

  test("a place with no id is dropped", () => {
    // The id is the dedupe key and the one field we may keep indefinitely.
    const page = mapPlacesResponse({ places: [{ displayName: { text: "No Id Co" } }] });
    expect(page.places).toEqual([]);
  });

  test("an empty or malformed body does not throw", () => {
    expect(mapPlacesResponse({}).places).toEqual([]);
    expect(mapPlacesResponse(null).places).toEqual([]);
    expect(mapPlacesResponse({ places: [] }).nextPageToken).toBeNull();
  });

  test("no rating or review count is ever produced", () => {
    // Not requested in the field mask, and not mapped even if returned — a
    // rating is Maps Content on a clock and a lead has no use for one.
    const page = mapPlacesResponse({
      places: [{ id: "ChIJabc", rating: 4.8, userRatingCount: 120 }],
    });
    expect(page.places[0]).not.toHaveProperty("rating");
    expect(page.places[0]).not.toHaveProperty("reviewCount");
  });
});

describe("the money rails", () => {
  test("a charge is written before any call could be made", async () => {
    const h = harness();
    await withCap(h, 1000);

    const charge = await h.mutation(internal.sourcing.chargeForSearch, {
      at: AUG,
      runId: "r1",
    });
    expect(charge.costCents).toBe(60);

    const rows = await h.run((ctx) => ctx.db.query("apiSpend").collect());
    expect(rows, "the ledger records the intent, not the outcome").toHaveLength(1);
    expect(rows[0]?.operation).toBe("textSearch");
  });

  test("no cap configured refuses, rather than running uncapped", async () => {
    const h = harness();
    await expect(
      h.mutation(internal.sourcing.chargeForSearch, { at: AUG, runId: "r1" }),
    ).rejects.toThrow(/No spend cap/i);

    const rows = await h.run((ctx) => ctx.db.query("apiSpend").collect());
    expect(rows).toEqual([]);
  });

  test("the cap refuses the call that would cross it", async () => {
    const h = harness();
    await withCap(h, 100); // two calls at 60c would be 120

    await h.mutation(internal.sourcing.chargeForSearch, { at: AUG, runId: "r1" });
    await expect(
      h.mutation(internal.sourcing.chargeForSearch, { at: AUG, runId: "r1" }),
    ).rejects.toThrow(/cap of 100 cents is reached/i);

    // And the refused call left no charge — the cap is not "charge then stop".
    const rows = await h.run((ctx) => ctx.db.query("apiSpend").collect());
    expect(rows).toHaveLength(1);
  });
});

describe("what we are licensed to keep", () => {
  test("a cached place expires 30 days out, computed for us", async () => {
    const h = harness();
    await h.mutation(internal.sourcing.cachePlaces, {
      now: AUG,
      places: [
        { placeId: "ChIJabc", displayName: "Renu Solar", attributionHtml: ["SolarZA"] },
      ],
    });

    const row = await h.run((ctx) => ctx.db.query("placesCache").collect());
    expect(row[0]?.expiresAt).toBe(AUG + PLACES_CACHE_MS);
  });

  /**
   * Enforcement is on READ, not on a sweeper. A sweeper that never runs costs
   * disk; a read that returns expired content is holding somebody else's data
   * outside the licence.
   */
  test("reading it back past the window returns nothing", async () => {
    const h = harness();
    await h.mutation(internal.sourcing.cachePlaces, {
      now: AUG,
      places: [{ placeId: "ChIJabc", displayName: "Renu Solar", attributionHtml: [] }],
    });

    const fresh = await h.run((ctx) => readPlace(ctx, "ChIJabc", AUG + 1000));
    expect(fresh?.displayName).toBe("Renu Solar");

    const stale = await h.run((ctx) => readPlace(ctx, "ChIJabc", AUG + PLACES_CACHE_MS + 1));
    expect(stale, "past the licence, there is nothing to hand back").toBeNull();
  });

  test("re-caching resets the clock rather than extending the old row", async () => {
    const h = harness();
    await h.mutation(internal.sourcing.cachePlaces, {
      now: AUG,
      places: [{ placeId: "ChIJabc", displayName: "Old Name", attributionHtml: [] }],
    });
    await h.mutation(internal.sourcing.cachePlaces, {
      now: AUG + 5000,
      places: [{ placeId: "ChIJabc", displayName: "New Name", attributionHtml: [] }],
    });

    const rows = await h.run((ctx) => ctx.db.query("placesCache").collect());
    expect(rows, "one place, one row").toHaveLength(1);
    expect(rows[0]?.displayName).toBe("New Name");
    expect(rows[0]?.expiresAt).toBe(AUG + 5000 + PLACES_CACHE_MS);
  });
});
