import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { solarTradesTemplate, buildAccentRamp } from "@cc/site-config";
import { reserveSpend, periodFor } from "./lib/placesBudget";
import { contactDecision } from "./lib/suppression";
import { readPlace, writePlace, PLACES_CACHE_MS } from "./lib/places";

/**
 * SOURCING: THE SPEND, THE LICENCE, AND WHO WE MAY CALL.
 *
 * Three failures, all silent. A loop that outruns its budget is an invoice
 * rather than an error. A cache that never expires is a database of somebody
 * else's licensed content. A suppression check that quietly returns nothing
 * is a phone call to a person who asked not to receive one.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const AUG = Date.UTC(2026, 7, 15);
const SEP = Date.UTC(2026, 8, 15);

async function withCap(h: Harness, capCents: number, at = AUG) {
  await h.run((ctx) =>
    ctx.db.insert("spendCaps", {
      provider: "google_places",
      period: periodFor(at),
      capCents,
      currency: "ZAR",
      unitCostCents: { textSearch: 60, placeDetails: 30 },
      updatedAt: at,
    }),
  );
}

const spend = (h: Harness, operation: string, units: number, at = AUG) =>
  h.run((ctx) => reserveSpend(ctx, { provider: "google_places", operation, units, at }));

describe("the spend cap is a ledger, not a constant", () => {
  test("a call under the cap is charged and allowed", async () => {
    const h = harness();
    await withCap(h, 10_000);
    const result = await spend(h, "textSearch", 10);
    expect(result.costCents).toBe(600);
    expect(result.spentCents).toBe(600);
  });

  test("spend accumulates across calls, so a loop cannot outrun it", async () => {
    // The failure being prevented: each call checking itself against the cap
    // and passing, forever, because nothing remembers the previous ones.
    const h = harness();
    await withCap(h, 1_000);
    await spend(h, "textSearch", 10); // 600
    const second = await spend(h, "textSearch", 5); // 300 -> 900
    expect(second.spentCents).toBe(900);
    await expect(spend(h, "textSearch", 5)).rejects.toThrow(/SPEND_CAP/);
  });

  test("the charge lands BEFORE the call, and is never refunded", async () => {
    /*
     * Deliberately the wrong side to err on, chosen because the errors cost
     * differently: over-counting refuses a call we could have afforded and is
     * fixed by raising the cap. Under-counting spends past it, and that money
     * is gone. A refund path would let a retry loop turn the cap into a
     * suggestion — fail, refund, retry, and the bill grows while the ledger
     * stays flat.
     */
    const h = harness();
    await withCap(h, 10_000);
    await spend(h, "textSearch", 1);
    const rows = await h.run((ctx) => ctx.db.query("apiSpend").collect());
    expect(rows).toHaveLength(1);
    expect(Object.keys(api)).not.toContain("refundSpend");
  });

  test("NO cap configured refuses every call — there is no unlimited mode", async () => {
    // An unconfigured deployment that spends freely is the failure this file
    // exists to prevent, and it costs real money before anyone notices.
    const h = harness();
    await expect(spend(h, "textSearch", 1)).rejects.toThrow(/NO_SPEND_CAP/);
  });

  test("an operation with no unit price is refused, not counted as free", async () => {
    const h = harness();
    await withCap(h, 10_000);
    await expect(spend(h, "nearbySearch", 1)).rejects.toThrow(/UNPRICED_OPERATION/);
  });

  test("the cap is per period — September does not inherit August's spend", async () => {
    const h = harness();
    await withCap(h, 1_000, AUG);
    await withCap(h, 1_000, SEP);
    await spend(h, "textSearch", 10, AUG);
    await expect(spend(h, "textSearch", 10, AUG)).rejects.toThrow(/SPEND_CAP/);
    // A fresh period starts at zero, which is what a monthly cap means.
    await expect(spend(h, "textSearch", 10, SEP)).resolves.toBeTruthy();
  });
});

describe("Places content expires because Google says so", () => {
  const place = {
    placeId: "ChIJ_test_001",
    displayName: "Upper Highway Solar",
    rating: 4.6,
    reviewCount: 41,
    attributionHtml: ['<a href="https://maps.google.com/">Listings by Google</a>'],
    googleMapsUri: "https://maps.google.com/?cid=1",
  };

  test("a fresh place reads back with its attribution attached", async () => {
    const h = harness();
    await h.run((ctx) => writePlace(ctx, place, AUG));
    const read = await h.run((ctx) => readPlace(ctx, place.placeId, AUG + 1000));
    expect(read?.rating).toBe(4.6);
    // The attribution travels with the data that requires it. A rating without
    // it is the breach that happens by omission.
    expect(read?.attributionHtml).toHaveLength(1);
  });

  test("one day past 30 days it reads as absent, not as stale", async () => {
    /*
     * Null, not "here it is but it's old". A caller holding the data will use
     * it, and serving a two-month-old rating as current is invisible to
     * everyone except the business whose rating moved.
     */
    const h = harness();
    await h.run((ctx) => writePlace(ctx, place, AUG));
    const read = await h.run((ctx) => readPlace(ctx, place.placeId, AUG + PLACES_CACHE_MS + 1));
    expect(read).toBeNull();
  });

  test("the row is still there — enforcement is on READ, not on a cleanup job", async () => {
    // An expiry implemented as a nightly sweep lapses the night the sweep
    // fails, and what is left is unlicensed content being served.
    const h = harness();
    await h.run((ctx) => writePlace(ctx, place, AUG));
    const after = AUG + PLACES_CACHE_MS + 1;
    expect(await h.run((ctx) => readPlace(ctx, place.placeId, after))).toBeNull();
    expect(await h.run((ctx) => ctx.db.query("placesCache").collect())).toHaveLength(1);
  });

  test("a re-fetch resets the clock rather than extending the old row", async () => {
    const h = harness();
    await h.run((ctx) => writePlace(ctx, place, AUG));
    await h.run((ctx) => writePlace(ctx, { ...place, rating: 4.8 }, SEP));
    const rows = await h.run((ctx) => ctx.db.query("placesCache").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rating).toBe(4.8);
    expect(rows[0]?.expiresAt).toBe(SEP + PLACES_CACHE_MS);
  });

  test("the lead table keeps only the placeId, which the terms exempt", async () => {
    const h = harness();
    const row = await h.run(async (ctx) => {
      const ventureId = await ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      });
      const id = await ctx.db.insert("leads", {
        ventureId,
        placeId: place.placeId,
        businessName: place.displayName,
        niche: "solar",
        auditFaults: [],
        status: "new",
        provenance: "places",
      });
      return ctx.db.get(id);
    });
    expect(row?.placeId).toBe(place.placeId);
    // A rating on this row would be a permanent copy of 30-day content.
    expect(row).not.toHaveProperty("rating");
    expect(row).not.toHaveProperty("reviewCount");
  });
});

describe("suppression fails closed", () => {
  const suppress = (h: Harness, kind: string, value: string) =>
    h.run((ctx) =>
      ctx.db.insert("suppressions", {
        kind: kind as "placeId" | "domain" | "phone" | "nameFragment",
        value,
        reason: "asked not to be contacted",
        createdAt: AUG,
      }),
    );

  test("an exact placeId match blocks", async () => {
    const h = harness();
    await suppress(h, "placeId", "ChIJ_x");
    const verdict = await h.run((ctx) => contactDecision(ctx, { placeId: "ChIJ_x" }));
    expect(verdict.blocked).toBe(true);
  });

  test("a phone in a different format still blocks", async () => {
    // "+27 82 555 1234" and "0825551234" are one person. Two formats reading
    // as two people is how a suppression list quietly stops working.
    const h = harness();
    await suppress(h, "phone", "+27 82 555 1234");
    const verdict = await h.run((ctx) => contactDecision(ctx, { phone: "0825551234" }));
    expect(verdict.blocked).toBe(true);
  });

  test("a subdomain of a suppressed domain is the same business", async () => {
    const h = harness();
    await suppress(h, "domain", "coastalplumbing.co.za");
    const verdict = await h.run((ctx) =>
      contactDecision(ctx, { domain: "https://www.shop.coastalplumbing.co.za/quote" }),
    );
    expect(verdict.blocked).toBe(true);
  });

  test("a NAME FRAGMENT blocks the family, not just the exact name", async () => {
    /*
     * The ambiguous case, and the one that matters. A human wrote "Coastal"
     * because they wanted that family of businesses left alone. Requiring an
     * exact match would let the suppression lapse the moment the business
     * restyled itself.
     */
    const h = harness();
    await suppress(h, "nameFragment", "Coastal");
    const verdict = await h.run((ctx) =>
      contactDecision(ctx, { businessName: "Coastal Plumbing & Drains" }),
    );
    expect(verdict.blocked).toBe(true);
  });

  test("NOTHING to check resolves to blocked, not to allowed", async () => {
    // No identifiers means no evidence either way, and no evidence is not
    // permission. This is the inversion the whole module exists for.
    const h = harness();
    const verdict = await h.run((ctx) => contactDecision(ctx, {}));
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/no identifier/);
  });

  test("an unparseable phone resolves to blocked", async () => {
    const h = harness();
    const verdict = await h.run((ctx) => contactDecision(ctx, { phone: "n/a" }));
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/cannot normalise/);
  });

  test("a FAILED LOOKUP resolves to blocked", async () => {
    /*
     * The case that gives the module its name. The ctx is deliberately broken
     * so the query throws — an error means we do not know whether this person
     * said no, and not knowing is not permission.
     */
    const broken = {
      db: {
        query: () => {
          throw new Error("database unavailable");
        },
      },
    } as never;
    const verdict = await contactDecision(broken, { phone: "0825551234" });
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/lookup failed/);
  });

  test("a clean lead with a real identifier is allowed", async () => {
    // The rule must not degenerate into "nobody may ever be contacted".
    const h = harness();
    await suppress(h, "phone", "+27 82 555 1234");
    const verdict = await h.run((ctx) =>
      contactDecision(ctx, { phone: "0839990000", businessName: "Hillcrest Electrical" }),
    );
    expect(verdict.blocked).toBe(false);
  });
});

describe("a demo site cannot outlive its expiry", () => {
  /**
   * A demo carries a real business's name, suburb and Google rating. Left up
   * it is an indexable impersonation of a business trading in its own name.
   * The gate is in the BACKEND so no renderer can bypass it — the config is
   * never handed over, so there is nothing to accidentally draw.
   */
  async function site(over: {
    isDemo: boolean;
    status?: "draft" | "demo" | "live";
    demoExpiresAt?: number;
  }) {
    const h = harness();
    await h.run(async (ctx) => {
      const ventureId = await ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      });
      const clientId = await ctx.db.insert("clients", {
        ventureId, kind: "platform", name: "Upper Highway Solar", slug: "uhs",
        status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: over.isDemo, isSeed: false,
      });
      /*
       * The REAL template, not a hand-rolled object. A config that only
       * exists in this test would let the gate pass here and fail on the
       * thing it actually serves — safeParseSiteConfig runs on read.
       */
      const config = solarTradesTemplate({
        businessName: "Upper Highway Solar",
        slug: "uhs",
        brandColour: "#1f6f43",
        accent: buildAccentRamp("#1f6f43"),
        city: "Durban",
        region: "KwaZulu-Natal",
        suburb: "Hillcrest",
        addressLine: "12 Old Main Road",
        phone: "+27315551234",
      });
      await ctx.db.insert("sites", {
        clientId, slug: "uhs",
        status: over.status ?? (over.isDemo ? "demo" : "live"),
        config, publishedConfig: config,
        version: 1, configSchemaVersion: 1,
        demoExpiresAt: over.demoExpiresAt,
        isDemo: over.isDemo,
      });
    });
    return h.query(api.public.site.resolve, { slug: "uhs" });
  }

  const in30Days = Date.now() + 30 * 24 * 60 * 60 * 1000;

  test("a live demo inside its window serves, with its demo context", async () => {
    const result = await site({ isDemo: true, demoExpiresAt: in30Days });
    expect(result.kind).toBe("site");
    if (result.kind !== "site") return;
    // Non-null for every demo that gets here — the renderer relies on it and
    // throws rather than drawing a demo without its disclosure.
    expect(result.demo?.subjectName).toBe("Upper Highway Solar");
  });

  test("an expired demo serves a notice, never the site", async () => {
    const result = await site({ isDemo: true, demoExpiresAt: Date.now() - 1000 });
    expect(result.kind).toBe("holding");
    if (result.kind !== "holding") return;
    expect(result.reason).toBe("demo_expired");
  });

  test("a demo with NO expiry is refused — this used to serve forever", async () => {
    /*
     * The fail-OPEN hole. The check read `&& site.demoExpiresAt`, so a demo
     * created without one skipped the expiry entirely, on the single page
     * type that carries somebody else's business name.
     */
    const result = await site({ isDemo: true, demoExpiresAt: undefined });
    expect(result.kind).toBe("holding");
    if (result.kind !== "holding") return;
    expect(result.reason).toBe("demo_expired");
  });

  test("a demo whose status was moved to live is still gated", async () => {
    /*
     * The other hole. The check keyed on `status === "demo"`, so moving the
     * status to "live" — an ordinary thing to do by accident — took the demo
     * out of the expiry regime while it still carried the real name.
     */
    const result = await site({
      isDemo: true,
      status: "live",
      demoExpiresAt: Date.now() - 1000,
    });
    expect(result.kind).toBe("holding");
    if (result.kind !== "holding") return;
    expect(result.reason).toBe("demo_expired");
  });

  test("a real client's site is unaffected and carries no demo context", async () => {
    const result = await site({ isDemo: false });
    expect(result.kind).toBe("site");
    if (result.kind !== "site") return;
    expect(result.demo).toBeNull();
  });
});
