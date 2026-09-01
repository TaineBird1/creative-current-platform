import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { solarTradesTemplate, buildAccentRamp, safeParseSiteConfig } from "@cc/site-config";
import { reserveSpend, periodFor } from "./lib/placesBudget";
import { contactDecision, filterContactable } from "./lib/suppression";
import { toE164, samePhone } from "./lib/phone";
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

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

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
        provenance: {
          source: "places",
          capturedAt: AUG,
          lawfulBasis: "legitimate_interest",
          detail: "Places textSearch: solar installers Hillcrest",
        },
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
    expect(verdict.reason).toMatch(/cannot read the phone/);
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

describe("a demo form tells the customer nothing was booked", () => {
  /**
   * The fail-open this closes: a demo submission is logged as engagement and
   * reaches nobody. Answered with the site's own success message, a real
   * customer who found the demo waits in for a tradesman nobody sent.
   *
   * The verdict is decided in the backend because that is the only place that
   * knows whether anything was dispatched. A template working it out for
   * itself is a template that can be wrong.
   */
  async function submitTo(isDemo: boolean) {
    const h = harness();
    await h.run(async (ctx) => {
      const ventureId = await ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      });
      const clientId = await ctx.db.insert("clients", {
        ventureId, kind: "platform", name: "Upper Highway Solar", slug: "uhs",
        status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo, isSeed: false,
      });
      const config = solarTradesTemplate({
        businessName: "Upper Highway Solar", slug: "uhs", brandColour: "#1f6f43",
        accent: buildAccentRamp("#1f6f43"), city: "Durban", region: "KwaZulu-Natal",
        suburb: "Hillcrest", addressLine: "12 Old Main Road", phone: "+27315551234",
      });
      await ctx.db.insert("sites", {
        clientId, slug: "uhs", status: isDemo ? "demo" : "live",
        config, publishedConfig: config, version: 1, configSchemaVersion: 1,
        demoExpiresAt: isDemo ? Date.now() + 30 * 24 * 60 * 60 * 1000 : undefined,
        isDemo,
      });
    });

    const parsed = safeParseSiteConfig(
      await h.run(async (ctx) => (await ctx.db.query("sites").collect())[0]!.publishedConfig),
    );
    if (!parsed.success) throw new Error("template did not parse");
    const quote = parsed.data.sections.find((section) => section.type === "quote");
    if (!quote) throw new Error("the template has no quote section");

    const answers: Record<string, string> = {};
    if (quote.type === "quote") {
      for (const field of quote.fields) {
        if (field.required && field.kind !== "photos") answers[field.key] = "Yes";
      }
    }

    const result = await h.mutation(api.public.quote.submit, {
      slug: "uhs",
      sectionId: quote.id,
      name: "Thandi M",
      phone: "0825551234",
      answers,
      consentAccepted: true,
    });
    return { h, result };
  }

  test("a demo submission comes back with a notice saying nothing was booked", async () => {
    const { result } = await submitTo(true);
    expect(result.recorded).toBe(false);
    expect(result.notice?.title).toMatch(/nothing was booked/i);
    // It also has to say what to do instead. "Nothing happened" without a
    // route to the real business leaves the customer no better off.
    expect(result.notice?.body).toMatch(/contact the business directly/i);
  });

  test("the notice names the agency and denies the affiliation", async () => {
    const { result } = await submitTo(true);
    expect(result.notice?.body).toMatch(/The Creative Current/);
    expect(result.notice?.body).toMatch(/not this business's site/i);
  });

  test("a real site gets no notice, so its own success message shows", async () => {
    // The rule must not degenerate into every form apologising.
    const { result } = await submitTo(false);
    expect(result.recorded).toBe(true);
    expect(result.notice).toBeNull();
  });

  test("the demo submission is still RECORDED — it is engagement, not nothing", async () => {
    // The prospect tapping their own demo's form is the strongest buying
    // signal in the funnel. It is logged; it just reaches no customer. The
    // notice is about what the CUSTOMER is told, not about discarding data.
    const { h } = await submitTo(true);
    const rows = await h.run((ctx) => ctx.db.query("quoteRequests").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isDemo).toBe(true);
  });

  test("and dispatch still refuses to message anyone about it", async () => {
    // Recorded is not contacted. The demo block in dispatch is what keeps
    // those two apart, and it is asserted here from the demo's own side.
    const { h } = await submitTo(true);
    expect(await h.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
  });
});

describe("Todays Queue never draws a suppressed business", () => {
  /**
   * The constraint: suppression filters the QUEUE, not the dial. Blocking at
   * the moment of dialling is one step too late — the name and number are
   * already on the screen, and a person who can see a number will phone it
   * from their own handset, where nothing records it and nothing stops it.
   */
  async function seedQueue() {
    const h = harness();
    const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    const owner = asUser(h, userId);
    const ventureId = await h.run((ctx) =>
      ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      }),
    );

    const lead = (name: string, phone: string, placeId: string) =>
      h.run((ctx) =>
        ctx.db.insert("leads", {
          ventureId,
          placeId,
          businessName: name,
          niche: "solar",
          phone,
          auditFaults: ["no https", "no phone above the fold"],
          status: "new",
          provenance: {
            source: "places",
            capturedAt: AUG,
            lawfulBasis: "legitimate_interest",
            detail: "Places textSearch: solar installers Hillcrest",
          },
        }),
      );

    const keep = await lead("Hillcrest Solar", "+27825550001", "ChIJ_keep");
    const refused = await lead("Coastal Plumbing", "+27825550002", "ChIJ_refused");
    return { h, owner, ventureId, keep, refused };
  }

  test("a suppressed lead is absent from the queue entirely", async () => {
    const s = await seedQueue();
    await s.h.run((ctx) =>
      ctx.db.insert("suppressions", {
        kind: "phone", value: "0825550002",
        reason: "asked not to be contacted", createdAt: AUG,
      }),
    );

    const result = await s.owner.query(api.queue.today, {});
    const names = result.rows.map((row) => row.businessName);

    expect(names).toContain("Hillcrest Solar");
    // Not "present but flagged". Absent. A flagged row is still a name and a
    // number on a screen someone can dial from.
    expect(names).not.toContain("Coastal Plumbing");
    expect(result.rows.some((row) => row.phone === "+27825550002")).toBe(false);
  });

  test("the queue says HOW MANY it withheld, so it is never a mystery", async () => {
    const s = await seedQueue();
    await s.h.run((ctx) =>
      ctx.db.insert("suppressions", {
        kind: "placeId", value: "ChIJ_refused",
        reason: "asked not to be contacted", createdAt: AUG,
      }),
    );
    const result = await s.owner.query(api.queue.today, {});
    expect(result.suppressedCount).toBe(1);
  });

  test("saying NOT INTERESTED removes them from the NEXT queue immediately", async () => {
    /*
     * The gap between "they said no" and "they stop appearing" is the window
     * in which somebody phones them again — and the person on the other end
     * cannot tell an administrative delay from contempt.
     */
    const s = await seedQueue();
    expect((await s.owner.query(api.queue.today, {})).rows).toHaveLength(2);

    await s.owner.mutation(api.queue.disposition, {
      leadId: s.refused,
      outcome: "not_interested",
      note: "Told me to take them off the list",
    });

    const after = await s.owner.query(api.queue.today, {});
    expect(after.rows.map((row) => row.businessName)).toEqual(["Hillcrest Solar"]);
  });

  test("a refusal suppresses the placeId AND the phone, closing both routes back", async () => {
    // The placeId stops them reappearing from a future Places pull under a
    // slightly different name; the phone stops the same number arriving
    // through another source entirely.
    const s = await seedQueue();
    await s.owner.mutation(api.queue.disposition, {
      leadId: s.refused, outcome: "not_interested",
    });
    const kinds = (await s.h.run((ctx) => ctx.db.query("suppressions").collect()))
      .map((row) => row.kind)
      .sort();
    expect(kinds).toEqual(["phone", "placeId"]);
  });

  test("when the suppression list cannot be read the queue is EMPTY, not unfiltered", async () => {
    /*
     * The failure that decides the design. An empty queue is visibly wrong
     * and someone investigates. A full queue that skipped the check looks
     * exactly like a normal working day, and the people on it get phoned.
     */
    const broken = { db: { query: () => { throw new Error("unavailable"); } } } as never;
    const result = await filterContactable(broken, [1, 2, 3], () => ({ phone: "0825550001" }));
    expect(result.allowed).toEqual([]);
    expect(result.blockedCount).toBe(3);
    // And the caller is told WHY, so the UI can say so rather than showing an
    // empty list that reads as "you are done for the day".
    expect(result.listUnavailable).toBe(true);
  });

  test("a callback the prospect asked for outranks everything else", async () => {
    const s = await seedQueue();
    await s.owner.mutation(api.queue.disposition, {
      leadId: s.keep,
      outcome: "callback",
      callbackAt: AUG,
      now: AUG - 1000,
    });
    const result = await s.owner.query(api.queue.today, {});
    expect(result.rows[0]?.businessName).toBe("Hillcrest Solar");
    expect(result.rows[0]?.rank).toBe("callback");
  });

  test("a callback with no time is refused — it is a promise nobody can keep", async () => {
    const s = await seedQueue();
    await expect(
      s.owner.mutation(api.queue.disposition, { leadId: s.keep, outcome: "callback" }),
    ).rejects.toThrow(/CALLBACK_NEEDS_A_TIME/);
  });

  test("the detail view SHOWS a suppressed lead, with the reason", async () => {
    /*
     * Deliberately not hidden. Somebody chasing "why has nobody contacted
     * Coastal Plumbing" needs to find the answer — a row that has vanished
     * sends them to re-source the same business and start again.
     */
    const s = await seedQueue();
    await s.owner.mutation(api.queue.disposition, {
      leadId: s.refused, outcome: "not_interested",
    });
    const detail = await s.owner.query(api.queue.lead, { leadId: s.refused });
    expect(detail.blocked).toBe(true);
    expect(detail.blockedReason).toMatch(/asked not to be contacted/);
  });
});

describe("provenance answers where did you get my number", () => {
  test("the row carries the source, when it was captured and the basis", async () => {
    const h = harness();
    const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    const owner = asUser(h, userId);
    const ventureId = await h.run((ctx) =>
      ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      }),
    );
    const leadId = await h.run((ctx) =>
      ctx.db.insert("leads", {
        ventureId, placeId: "ChIJ_x", businessName: "Hillcrest Solar", niche: "solar",
        phone: "+27825550001", auditFaults: [], status: "new",
        provenance: {
          source: "places",
          capturedAt: AUG,
          lawfulBasis: "legitimate_interest",
          detail: "Places textSearch: solar installers Hillcrest",
        },
      }),
    );

    const detail = await owner.query(api.queue.lead, { leadId });
    expect(detail.provenance.source).toBe("places");
    expect(detail.provenance.capturedAt).toBe(AUG);
    expect(detail.provenance.lawfulBasis).toBe("legitimate_interest");
    // The source alone answers "from Google Places", and the follow-up is
    // always "yes, but how did I end up on your list".
    expect(detail.provenance.detail).toMatch(/textSearch/);
  });

  test("a lead cannot be created without it", async () => {
    const h = harness();
    const ventureId = await h.run((ctx) =>
      ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      }),
    );
    await expect(
      h.run((ctx) =>
        ctx.db.insert("leads", {
          ventureId, placeId: "ChIJ_y", businessName: "No Origin Co", niche: "solar",
          auditFaults: [], status: "new",
        } as never),
      ),
    ).rejects.toThrow();
  });
});

describe("one phone normaliser, because the phone is the key", () => {
  /**
   * There were three canonical forms in this codebase — "+27833176385",
   * "833176385" and "0833176385" — and they agreed only because every
   * comparison re-normalised both sides. The divergence was latent, not
   * absent: one import path storing a raw string and a suppressed number is
   * back on the queue with every test green.
   */
  test("the formats a South African number actually arrives in all agree", () => {
    const forms = [
      "0833176385",
      "083 317 6385",
      "083-317-6385",
      "+27 83 317 6385",
      "+27833176385",
      "27833176385",
      "0027833176385",
      "(083) 317 6385",
    ];
    for (const form of forms) {
      expect(toE164(form), form).toMatchObject({ ok: true, e164: "+27833176385" });
    }
  });

  test("the first of two numbers is the key, and the rest is kept", () => {
    // Three real rows in the campaign list look like this.
    const parsed = toE164("0833176385 / 0622155142");
    expect(parsed.e164).toBe("+27833176385");
    // Nothing is lost: display keeps the second number, which is the only
    // record that it exists at all.
    expect(parsed.display).toBe("0833176385 / 0622155142");
  });

  test("a parenthetical LABEL is dropped but a bracketed AREA CODE is not", () => {
    /*
     * These look identical to a regex that strips parentheses, and the first
     * version stripped both — turning "(031) 940 3961" into seven digits and
     * losing a working Durban landline. A letter inside is what makes it a
     * note.
     */
    expect(toE164("0832070485 (WhatsApp) / 0870744449").e164).toBe("+27832070485");
    expect(toE164("(031) 940 3961").e164).toBe("+27319403961");
    expect(toE164("(031) 940 3961 (after hours)").e164).toBe("+27319403961");
  });

  test("a number that is not South African is REFUSED, not guessed at", () => {
    /*
     * The important half. A normaliser that always returns something turns a
     * typo into a key that matches nothing — and matching nothing means the
     * do-not-call list has no opinion, which reads as permission.
     */
    for (const bad of ["12345", "", "n/a", "+44 20 7946 0958", "083317638500"]) {
      expect(toE164(bad).ok, bad).toBe(false);
      expect(toE164(bad).e164, bad).toBeNull();
    }
  });

  test("the refusal quotes the number, so the source row can be fixed", () => {
    const parsed = toE164("12345");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("12345");
  });

  test("samePhone matches across formats and refuses on either side unparsed", () => {
    expect(samePhone("0833176385", "+27 83 317 6385")).toBe(true);
    expect(samePhone("0833176385", "0622155142")).toBe(false);
    // Unparseable is NOT a match — the caller treats that as blocked, which
    // is the direction that cannot get somebody phoned.
    expect(samePhone("0833176385", "n/a")).toBe(false);
  });

  test("a suppression written in ANY format still blocks an E.164 lead", async () => {
    /*
     * The scenario the consolidation is for: a suppression typed by hand off
     * a note, against a lead whose number was normalised at import.
     */
    const h = harness();
    await h.run((ctx) =>
      ctx.db.insert("suppressions", {
        kind: "phone",
        value: "083 317 6385",
        reason: "asked not to be contacted",
        createdAt: AUG,
      }),
    );
    const verdict = await h.run((ctx) => contactDecision(ctx, { phone: "+27833176385" }));
    expect(verdict.blocked).toBe(true);
  });

  test("and the reverse: an E.164 suppression blocks a lead in national form", async () => {
    const h = harness();
    await h.run((ctx) =>
      ctx.db.insert("suppressions", {
        kind: "phone",
        value: "+27833176385",
        reason: "asked not to be contacted",
        createdAt: AUG,
      }),
    );
    const verdict = await h.run((ctx) => contactDecision(ctx, { phone: "0833176385" }));
    expect(verdict.blocked).toBe(true);
  });
});

describe("the queue holds only rows that can be dialled", () => {
  async function seedMixed() {
    const h = harness();
    const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    const owner = asUser(h, userId);
    const ventureId = await h.run((ctx) =>
      ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      }),
    );
    const make = (name: string, phone?: string, phoneDisplay?: string) =>
      h.run((ctx) =>
        ctx.db.insert("leads", {
          ventureId,
          businessName: name,
          niche: "solar",
          phone,
          phoneDisplay,
          auditFaults: [],
          status: "new",
          provenance: {
            source: "campaign_list",
            capturedAt: AUG,
            lawfulBasis: "legitimate_interest",
            detail: "SolarZA directory listing",
          },
        }),
      );

    await make("Callable Solar", "+27825550001", "0825550001");
    await make("No Number Solar");
    await make("Also No Number");
    return { h, owner };
  }

  test("a lead with no number is not in the queue at all", async () => {
    /*
     * Not greyed out, not disabled — absent. A row you tap dial on where
     * nothing happens teaches you the dial button is sometimes a lie, and
     * three of those in a morning is enough to stop trusting the screen.
     */
    const s = await seedMixed();
    const result = await s.owner.query(api.queue.today, {});
    expect(result.rows.map((row) => row.businessName)).toEqual(["Callable Solar"]);
    for (const row of result.rows) expect(row.phone).toBeTruthy();
  });

  test("they are COUNTED, so the shortfall is never a mystery", async () => {
    const s = await seedMixed();
    const result = await s.owner.query(api.queue.today, {});
    expect(result.needsNumberCount).toBe(2);
  });

  test("and they are listed separately, as research rather than calling", async () => {
    const s = await seedMixed();
    const rows = await s.owner.query(api.queue.needsNumber, {});
    expect(rows.map((row) => row.businessName).sort()).toEqual([
      "Also No Number",
      "No Number Solar",
    ]);
  });

  test("the needs-a-number list is suppression-filtered too", async () => {
    // Someone who asked not to be contacted should not appear on a list of
    // businesses to go and find a number for.
    const s = await seedMixed();
    await s.h.run((ctx) =>
      ctx.db.insert("suppressions", {
        kind: "nameFragment", value: "No Number Solar",
        reason: "asked not to be contacted", createdAt: AUG,
      }),
    );
    const rows = await s.owner.query(api.queue.needsNumber, {});
    expect(rows.map((row) => row.businessName)).toEqual(["Also No Number"]);
  });

  test("the queue keeps the original string beside the dialling key", async () => {
    const s = await seedMixed();
    const result = await s.owner.query(api.queue.today, {});
    expect(result.rows[0]?.phone).toBe("+27825550001");
    expect(result.rows[0]?.phoneDisplay).toBe("0825550001");
  });
});

describe("a customer we cannot message is told at the time", () => {
  /**
   * The silent failure: a number that does not reach E.164 cannot be checked
   * against the do-not-call list, so dispatch suppresses everything to it.
   * That is correct, and it is invisible to the person who typed it — the
   * outbox row explaining it belongs to the BUSINESS. They submit, the
   * confirmation is dropped, and they wait.
   *
   * Same shape as the demo form, same answer: the backend knows at submission
   * time, so it says so then.
   */
  async function submitWithPhone(phone: string) {
    const h = harness();
    await h.run(async (ctx) => {
      const ventureId = await ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      });
      const clientId = await ctx.db.insert("clients", {
        ventureId, kind: "platform", name: "Hillcrest Guest House", slug: "hgh",
        status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      });
      const config = solarTradesTemplate({
        businessName: "Hillcrest Guest House", slug: "hgh", brandColour: "#1f6f43",
        accent: buildAccentRamp("#1f6f43"), city: "Durban", region: "KwaZulu-Natal",
        suburb: "Hillcrest", addressLine: "12 Old Main Road", phone: "+27315551234",
      });
      await ctx.db.insert("sites", {
        clientId, slug: "hgh", status: "live", config, publishedConfig: config,
        version: 1, configSchemaVersion: 1, isDemo: false,
      });
    });

    const parsed = safeParseSiteConfig(
      await h.run(async (ctx) => (await ctx.db.query("sites").collect())[0]!.publishedConfig),
    );
    if (!parsed.success) throw new Error("template did not parse");
    const quote = parsed.data.sections.find((section) => section.type === "quote")!;

    const answers: Record<string, string> = {};
    if (quote.type === "quote") {
      for (const field of quote.fields) {
        if (field.required && field.kind !== "photos") answers[field.key] = "Yes";
      }
    }

    const result = await h.mutation(api.public.quote.submit, {
      slug: "hgh",
      sectionId: quote.id,
      name: "Visitor",
      phone,
      answers,
      consentAccepted: true,
    });
    return { h, result };
  }

  test("a South African number is reachable and gets no notice", async () => {
    const { result } = await submitWithPhone("0825551234");
    expect(result.reachable).toBe(true);
    expect(result.notice).toBeNull();
  });

  test("a foreign number is told we will PHONE rather than message", async () => {
    const { result } = await submitWithPhone("+44 20 7946 0958");
    expect(result.reachable).toBe(false);
    expect(result.notice?.title).toMatch(/phone you/i);
    // And what to do about it, if they would rather have it in writing.
    expect(result.notice?.body).toMatch(/South African number/i);
  });

  test("the enquiry is still RECORDED — this is not a rejection", async () => {
    /*
     * Refusing the number would turn a messaging limitation into a lost
     * booking. The business would rather have the enquiry and phone them.
     */
    const { h, result } = await submitWithPhone("+44 20 7946 0958");
    expect(result.ok).toBe(true);
    const rows = await h.run((ctx) => ctx.db.query("quoteRequests").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone).toBe("+44 20 7946 0958");
  });

  test("the demo notice still outranks it — nothing was booked beats how we reply", async () => {
    // Both can apply at once. "Nothing was booked at all" is the more
    // important of the two things to say, so it wins.
    const h = harness();
    await h.run(async (ctx) => {
      const ventureId = await ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      });
      const clientId = await ctx.db.insert("clients", {
        ventureId, kind: "platform", name: "Demo Solar", slug: "demo",
        status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: true, isSeed: false,
      });
      const config = solarTradesTemplate({
        businessName: "Demo Solar", slug: "demo", brandColour: "#1f6f43",
        accent: buildAccentRamp("#1f6f43"), city: "Durban", region: "KwaZulu-Natal",
        suburb: "Hillcrest", addressLine: "12 Old Main Road", phone: "+27315551234",
      });
      await ctx.db.insert("sites", {
        clientId, slug: "demo", status: "demo", config, publishedConfig: config,
        version: 1, configSchemaVersion: 1, isDemo: true,
        demoExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });
    });
    const parsed = safeParseSiteConfig(
      await h.run(async (ctx) => (await ctx.db.query("sites").collect())[0]!.publishedConfig),
    );
    if (!parsed.success) throw new Error("template did not parse");
    const quote = parsed.data.sections.find((section) => section.type === "quote")!;
    const answers: Record<string, string> = {};
    if (quote.type === "quote") {
      for (const field of quote.fields) {
        if (field.required && field.kind !== "photos") answers[field.key] = "Yes";
      }
    }
    const result = await h.mutation(api.public.quote.submit, {
      slug: "demo", sectionId: quote.id, name: "Visitor",
      phone: "+44 20 7946 0958", answers, consentAccepted: true,
    });
    expect(result.notice?.title).toMatch(/nothing was booked/i);
  });

  test("staff creating a customer are told too", async () => {
    /*
     * The other capture point. The person typing it is the only one who can
     * still ask for a different number, and only if they are told now rather
     * than finding it in an outbox three days later.
     */
    const h = harness();
    const ids = await h.run(async (ctx) => {
      const ventureId = await ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      });
      const clientId = await ctx.db.insert("clients", {
        ventureId, kind: "platform", name: "Alpha", slug: "alpha", status: "live",
        timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      });
      const user = await ctx.db.insert("users", { email: "owner@alpha.test" });
      await ctx.db.insert("memberships", {
        userId: user, clientId, role: "owner", active: true, acceptedAt: Date.now(),
      });
      return { user };
    });
    const owner = asUser(h, ids.user);

    const local = await owner.mutation(api.customers.upsertByPhone, {
      clientSlug: "alpha", name: "Thabo M", phone: "0825551234",
    });
    expect(local.reachable).toBe(true);

    const foreign = await owner.mutation(api.customers.upsertByPhone, {
      clientSlug: "alpha", name: "Anna V", phone: "+44 20 7946 0958",
    });
    expect(foreign.reachable).toBe(false);
  });

  test("and dispatch really does suppress that customer, which is why it is said", async () => {
    // The two halves have to agree, or the notice is a lie in one direction
    // or the other. This is the half that makes the warning true.
    const h = harness();
    const verdict = await h.run((ctx) => contactDecision(ctx, { phone: "442079460958" }));
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toMatch(/cannot read the phone/);
  });
});
