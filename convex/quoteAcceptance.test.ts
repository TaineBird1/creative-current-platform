import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * ACCEPTING A QUOTE IS THE CLOSEST THING HERE TO SIGNING SOMETHING.
 *
 * Two properties, and both are about the moment somebody disputes a price —
 * which is the only moment either is ever read.
 *
 * WHAT THEY AGREED TO IS SNAPSHOTTED. Before `quoteAcceptances` existed, the
 * only record was the quote row, which staff can edit afterwards. "What did
 * they agree to" was therefore answerable only as "whatever it says now",
 * which is not an answer.
 *
 * ONE TAP OR TEN, ONE ACCEPTANCE. The usage scene is a customer on a phone
 * with one bar, on a page that took a moment to respond.
 */

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);

  const ids = await t.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Renu Solar", slug: "renu-solar",
      status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
      featureFlags: {}, isDemo: false, isSeed: false,
    });
    const locationId = await ctx.db.insert("locations", {
      clientId, name: "Hillcrest", addressLine: "12 Old Main Rd", suburb: "Hillcrest",
      city: "Durban", region: "KwaZulu-Natal", countryCode: "ZA",
      timezone: "Africa/Johannesburg", active: true,
    });
    const owner = await ctx.db.insert("users", { email: "owner@renu.test" });
    await ctx.db.insert("memberships", {
      userId: owner, clientId, role: "owner", active: true, acceptedAt: Date.now(),
    });
    return { ventureId, clientId, locationId, ownerUserId: owner };
  });

  const owner = t.withIdentity({ subject: `${ids.ownerUserId}|test-session` });
  const { customerId } = await owner.mutation(api.customers.upsertByPhone, {
    clientSlug: "renu-solar", name: "Thabo Mokoena", phone: "0825551234",
  });

  return { t, ...ids, owner, customerId };
}

/** A sent quote, plus the plaintext token that opens it. */
async function sentQuote(
  t: Awaited<ReturnType<typeof setup>>["t"],
  ids: { clientId: Id<"clients">; customerId: Id<"customers"> },
  lineItems = [
    { description: "8kW inverter, fitted", quantity: 1, unitPriceCents: 4_800_000, taxable: false },
    { description: "455W panels", quantity: 12, unitPriceCents: 320_000, taxable: false },
  ],
) {
  const { hashToken, newInviteToken } = await import("./lib/invites");
  const token = newInviteToken();

  const quoteId = await t.run(async (ctx) => {
    const subtotal = lineItems.reduce(
      (sum, l) => sum + Math.round(l.unitPriceCents * l.quantity),
      0,
    );
    return ctx.db.insert("quotes", {
      clientId: ids.clientId,
      customerId: ids.customerId,
      number: "QUO-0001",
      lineItems,
      subtotalCents: subtotal,
      totalCents: subtotal,
      currency: "ZAR",
      status: "sent",
      expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
      acceptTokenHash: await hashToken(token),
      isDemo: false,
    });
  });

  return { quoteId, token };
}

describe("what they agreed to is written down", () => {
  test("accepting records the lines, totals and terms", async () => {
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);

    await t.mutation(api.public.quote.accept, { token });

    const acceptance = await t.run((ctx) =>
      ctx.db
        .query("quoteAcceptances")
        .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
        .unique(),
    );

    expect(acceptance).not.toBeNull();
    expect(acceptance!.number).toBe("QUO-0001");
    expect(acceptance!.lineItems).toHaveLength(2);
    expect(acceptance!.totalCents).toBe(4_800_000 + 12 * 320_000);
    expect(acceptance!.currency).toBe("ZAR");
    // The terms: when the offer they said yes to would have lapsed.
    expect(acceptance!.validUntil).toBeGreaterThan(Date.now());
    expect(acceptance!.acceptedAt).toBeGreaterThan(0);
  });

  test("EDITING THE QUOTE AFTERWARDS DOES NOT CHANGE WHAT THEY AGREED TO", async () => {
    /*
     * The whole reason the table exists. Staff can edit a quote; if the
     * acceptance merely pointed at it, the record of a customer's agreement
     * would silently follow whatever the price became.
     */
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);

    await t.mutation(api.public.quote.accept, { token });

    await t.run((ctx) =>
      ctx.db.patch(quoteId, {
        totalCents: 9_900_000,
        subtotalCents: 9_900_000,
        lineItems: [
          { description: "Something else entirely", quantity: 1, unitPriceCents: 9_900_000, taxable: false },
        ],
      }),
    );

    const acceptance = await t.run((ctx) =>
      ctx.db
        .query("quoteAcceptances")
        .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
        .unique(),
    );

    expect(acceptance!.totalCents).toBe(4_800_000 + 12 * 320_000);
    expect(acceptance!.lineItems[0]!.description).toBe("8kW inverter, fitted");
    expect(acceptance!.lineItems).toHaveLength(2);
  });

  test("the job it created is named on it, when the branch was unambiguous", async () => {
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);

    const result = await t.mutation(api.public.quote.accept, { token });
    expect(result.jobCreated).toBe(true);

    const acceptance = await t.run((ctx) =>
      ctx.db
        .query("quoteAcceptances")
        .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
        .unique(),
    );
    expect(acceptance!.jobId).toBeDefined();
  });

  test("and is absent when the branch was ambiguous — the acceptance still stands", async () => {
    const { t, ...ids } = await setup();
    // A second active branch: which depot is now a guess, so no job is made.
    await t.run((ctx) =>
      ctx.db.insert("locations", {
        clientId: ids.clientId, name: "Ballito", addressLine: "1 Main Rd",
        suburb: "Ballito", city: "Ballito", region: "KwaZulu-Natal",
        countryCode: "ZA", timezone: "Africa/Johannesburg", active: true,
      }),
    );
    const { quoteId, token } = await sentQuote(t, ids);

    const result = await t.mutation(api.public.quote.accept, { token });
    expect(result.jobCreated).toBe(false);

    const acceptance = await t.run((ctx) =>
      ctx.db
        .query("quoteAcceptances")
        .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
        .unique(),
    );
    // The customer's act is recorded either way. Only the job is missing.
    expect(acceptance).not.toBeNull();
    expect(acceptance!.jobId).toBeUndefined();
  });
});

describe("ONE TAP OR TEN, ONE ACCEPTANCE", () => {
  test("a double tap does not produce two acceptances", async () => {
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);

    const first = await t.mutation(api.public.quote.accept, { token });
    const second = await t.mutation(api.public.quote.accept, { token });

    expect(first.alreadyAccepted).toBe(false);
    expect(second.alreadyAccepted).toBe(true);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("quoteAcceptances")
        .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("A SECOND TAP IS NOT AN ERROR", async () => {
    /*
     * It must not tell somebody who successfully accepted that they failed —
     * they would ring the business about it, which is the support call this
     * whole flow exists to prevent.
     */
    const { t, ...ids } = await setup();
    const { token } = await sentQuote(t, ids);

    await t.mutation(api.public.quote.accept, { token });
    const second = await t.mutation(api.public.quote.accept, { token });

    expect(second.alreadyAccepted).toBe(true);
    expect(second.number).toBe("QUO-0001");
    expect(second.totalCents).toBe(4_800_000 + 12 * 320_000);
  });

  test("THE ACCEPTANCE ROW ITSELF STOPS A SECOND ONE, not just the status", async () => {
    /*
     * Belt and braces, isolated so the belt is actually tested.
     *
     * A negative control caught this: disabling the `by_quote` check changed
     * nothing, because the status check refuses first. That makes the second
     * guard untested rather than redundant — and it is the one that matters if
     * a status is ever wrong, which is the only reason to have two.
     *
     * So: an acceptance exists, and the status says the quote is still out.
     */
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);

    await t.mutation(api.public.quote.accept, { token });
    await t.run((ctx) => ctx.db.patch(quoteId, { status: "sent", acceptedAt: undefined }));

    const again = await t.mutation(api.public.quote.accept, { token });
    expect(again.alreadyAccepted).toBe(true);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("quoteAcceptances")
        .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("only one job is created, however many taps", async () => {
    const { t, ...ids } = await setup();
    const { token } = await sentQuote(t, ids);

    await t.mutation(api.public.quote.accept, { token });
    await t.mutation(api.public.quote.accept, { token });
    await t.mutation(api.public.quote.accept, { token });

    const jobs = await t.run((ctx) => ctx.db.query("jobs").collect());
    expect(jobs).toHaveLength(1);
  });
});

describe("it refuses what it should refuse", () => {
  test("a withdrawn quote", async () => {
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);
    await t.run((ctx) => ctx.db.patch(quoteId, { status: "declined" }));

    await expect(t.mutation(api.public.quote.accept, { token })).rejects.toThrow(/withdrawn/);
  });

  test("an expired quote", async () => {
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);
    await t.run((ctx) => ctx.db.patch(quoteId, { expiresAt: Date.now() - 1000 }));

    await expect(t.mutation(api.public.quote.accept, { token })).rejects.toThrow(/expired/);
  });

  test("a quote that was never sent", async () => {
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);
    await t.run((ctx) => ctx.db.patch(quoteId, { status: "draft" }));

    await expect(t.mutation(api.public.quote.accept, { token })).rejects.toThrow(/not been sent/);
  });

  test("an unknown token, without saying whether it was close", async () => {
    const { t, ...ids } = await setup();
    await sentQuote(t, ids);

    await expect(
      t.mutation(api.public.quote.accept, { token: "b".repeat(64) }),
    ).rejects.toThrow(/not valid/);
  });

  test("and none of those write an acceptance", async () => {
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);
    await t.run((ctx) => ctx.db.patch(quoteId, { status: "declined" }));

    await expect(t.mutation(api.public.quote.accept, { token })).rejects.toThrow();

    const rows = await t.run((ctx) => ctx.db.query("quoteAcceptances").collect());
    expect(rows).toEqual([]);
  });
});

describe("the customer can read it before agreeing", () => {
  test("view returns the document without a session", async () => {
    const { t, ...ids } = await setup();
    const { token } = await sentQuote(t, ids);

    const doc = await t.query(api.public.quote.view, { token });
    expect(doc.number).toBe("QUO-0001");
    expect(doc.businessName).toBe("Renu Solar");
    expect(doc.lineItems).toHaveLength(2);
    expect(doc.acceptable).toBe(true);
  });

  test("an expired quote is SHOWN, marked expired, not refused", async () => {
    /*
     * Refusing reads as a broken link and sends them to ring up asking why
     * nothing works. They need to be told it lapsed and what to do about it.
     */
    const { t, ...ids } = await setup();
    const { quoteId, token } = await sentQuote(t, ids);
    await t.run((ctx) => ctx.db.patch(quoteId, { expiresAt: Date.now() - 1000 }));

    const doc = await t.query(api.public.quote.view, { token });
    expect(doc.expired).toBe(true);
    expect(doc.acceptable).toBe(false);
  });

  test("it returns no ids of any kind", async () => {
    const { t, ...ids } = await setup();
    const { token } = await sentQuote(t, ids);

    const doc = await t.query(api.public.quote.view, { token });
    for (const key of Object.keys(doc)) {
      expect(key.toLowerCase().endsWith("id")).toBe(false);
    }
  });
});

describe("nothing calls a function that does not do what it says", () => {
  test("quotes.send is gone; markSent and sendToCustomer replace it", async () => {
    const quotes = await import("./quotes");
    expect("send" in quotes).toBe(false);
    expect("markSent" in quotes).toBe(true);
    expect("sendToCustomer" in quotes).toBe(true);
  });

  test("markSent records the handover without dispatching", async () => {
    const { t, owner, ...ids } = await setup();
    const { quoteId } = await sentQuote(t, ids);
    await t.run((ctx) => ctx.db.patch(quoteId, { status: "draft" }));

    await owner.mutation(api.quotes.markSent, { clientSlug: "renu-solar", quoteId });

    const quote = await t.run((ctx) => ctx.db.get(quoteId));
    expect(quote!.status).toBe("sent");

    // The point of the rename: it queues nothing.
    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages).toEqual([]);
  });
});

describe("the acceptance record cannot be revised", () => {
  test("quoteAcceptances is on the immutable list", async () => {
    /*
     * Pinned by MEMBERSHIP here and by EQUALITY in guards.test.ts. A negative
     * control found this necessary: removing the table from IMMUTABLE_TABLES
     * broke nothing, because that guard only fires when some file actually
     * patches the table — and nothing does yet. The protection was latent, so
     * deleting it was silent.
     */
    const { IMMUTABLE_TABLES } = await import("./schema");
    expect(IMMUTABLE_TABLES).toContain("quoteAcceptances");
  });
});
