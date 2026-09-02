import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * WON MEANS THEY SAID YES. CONVERTED MEANS THEY EXIST.
 *
 * `deals.advance` stops at the first and says conversion is owed. This is the
 * function that pays that debt, and it does the whole of it in ONE
 * transaction — because every half of it is useless without the others, and
 * each partial state is its own quiet disaster.
 *
 * Most of the tests here are about those partial states never being reachable.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const SEP = Date.UTC(2026, 8, 2, 9);
const R = (rands: number) => rands * 100;

async function setUp(h: Harness, over: { confirmIssuer?: boolean; withDemo?: boolean } = {}) {
  const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
    email: "owner@thecreativecurrent.co.za",
  });
  const owner = h.withIdentity({ subject: `${userId}|test-session` });

  const ventureId = await h.run((ctx) =>
    ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    }),
  );

  const leadId = await h.run((ctx) =>
    ctx.db.insert("leads", {
      ventureId,
      businessName: "Upper Highway Solar",
      niche: "solar",
      phone: "+27825551234",
      phoneDisplay: "0825551234",
      area: "Hillcrest",
      auditFaults: [],
      status: "working",
      provenance: {
        source: "campaign_list", capturedAt: SEP, lawfulBasis: "legitimate_interest",
      },
    }),
  );

  if (over.confirmIssuer !== false) {
    await owner.mutation(api.issuer.set, {
      ventureId,
      legalName: "Taine Bird",
      addressLine: "12 Old Main Rd",
      city: "Durban",
      email: "hello@thecreativecurrent.co.za",
    });
    await owner.mutation(api.issuer.confirm, {
      ventureId,
      legalName: "Taine Bird",
    });
  }

  if (over.withDemo) {
    await owner.mutation(api.demos.createForLead, { leadId, now: SEP });
  }

  // A meeting set opens the deal; winning it is what makes conversion owed.
  const { dealId } = await owner.mutation(api.queue.disposition, {
    leadId, outcome: "meeting_set", now: SEP,
  });
  await owner.mutation(api.deals.advance, {
    dealId: dealId!, stage: "pricing_presented", valueCents: R(12_000), now: SEP,
  });
  const won = await owner.mutation(api.deals.advance, {
    dealId: dealId!, stage: "won", now: SEP,
  });
  expect(won.conversionOwed).toBe(true);

  return { h, owner, userId, ventureId, leadId, dealId: dealId! };
}

const convert = (
  s: Awaited<ReturnType<typeof setUp>>,
  over: Record<string, unknown> = {},
) =>
  s.owner.mutation(api.onboarding.convertWonDeal, {
    dealId: s.dealId,
    ownerEmail: "sipho@upperhighwaysolar.co.za",
    now: SEP,
    ...over,
  });

describe("a won deal becomes a client", () => {
  test("the lead is converted, and only now", async () => {
    /*
     * The write deals.advance deliberately refused to make. A lead in the
     * funnel's last column with no client behind it makes every count
     * downstream wrong, in the direction that flatters us.
     */
    const s = await setUp(harness());
    const before = (await s.h.run((ctx) => ctx.db.get(s.leadId)))!;
    expect(before.status).not.toBe("converted");

    const result = await convert(s);

    const after = (await s.h.run((ctx) => ctx.db.get(s.leadId)))!;
    expect(after.status).toBe("converted");
    expect(after.convertedClientId).toBe(result.clientId);
  });

  test("the client is real — neither demo nor seed", async () => {
    const s = await setUp(harness());
    const { clientId } = await convert(s);

    const client = (await s.h.run((ctx) => ctx.db.get(clientId as Id<"clients">)))!;
    expect(client.isDemo).toBe(false);
    expect(client.isSeed).toBe(false);
    expect(client.kind).toBe("platform");
    // Their own address, so their customers reply to THEM.
    expect(client.primaryContactEmail).toBe("sipho@upperhighwaysolar.co.za");
  });

  test("the owner gets an invite, and the token is returned exactly once", async () => {
    const s = await setUp(harness());
    const result = await convert(s);

    expect(result.inviteToken).toMatch(/.{16,}/);

    const invite = (await s.h.run((ctx) => ctx.db.get(result.inviteId as Id<"invites">)))!;
    expect(invite.tenantRole).toBe("owner");
    expect(invite.email).toBe("sipho@upperhighwaysolar.co.za");
    // Never stored in the clear.
    expect(invite.tokenHash).not.toBe(result.inviteToken);
  });

  test("the build invoice is raised, priced from the deal", async () => {
    const s = await setUp(harness());
    const result = await convert(s);

    expect(result.totalCents).toBe(R(12_000));
    expect(result.invoiceNumber).toMatch(/^INV-/);
    // The reference IS the number — see the invoice guard.
    expect(result.paymentReference).toContain("0001");
  });

  test("an explicit build fee overrides the deal's value", async () => {
    const s = await setUp(harness());
    const result = await convert(s, { buildFeeCents: R(9_500) });
    expect(result.totalCents).toBe(R(9_500));
  });

  test("the checklist says who each item is on", async () => {
    // What goes wrong in week one is a client waiting on us while we wait on
    // them, so every row carries an owner.
    const s = await setUp(harness());
    const { clientId } = await convert(s);

    const items = await s.h.run((ctx) =>
      ctx.db
        .query("onboardingItems")
        .withIndex("by_client_phase", (q) => q.eq("clientId", clientId as Id<"clients">))
        .collect(),
    );
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((i) => i.status === "pending")).toBe(true);
    expect(items.some((i) => i.owner === "client")).toBe(true);
    expect(items.some((i) => i.owner === "us")).toBe(true);
  });
});

describe("the demo is promoted, not replaced", () => {
  test("THE URL THEY WERE SOLD ON STAYS THEIRS", async () => {
    /*
     * The prospect has had that link in a WhatsApp thread for two weeks. A
     * fresh site would take a second slug, because the first is held by the
     * demo — so the address they were sold on would quietly become somebody
     * else's.
     */
    const s = await setUp(harness(), { withDemo: true });
    const demo = (await s.h.run((ctx) => ctx.db.query("sites").first()))!;

    const result = await convert(s);

    expect(result.promotedDemo).toBe(true);
    expect(result.slug).toBe(demo.slug);
    expect(result.siteId).toBe(demo._id);

    // One client and one site, not two of each.
    expect(await s.h.run((ctx) => ctx.db.query("sites").collect())).toHaveLength(1);
    expect(await s.h.run((ctx) => ctx.db.query("clients").collect())).toHaveLength(1);
  });

  test("THE EXPIRY IS CLEARED, or the site goes dark 30 days after they pay", async () => {
    /*
     * public/site refuses to serve a site whose expiry has passed. A promoted
     * site that kept its demo expiry is a client whose website vanishes a
     * month into the relationship.
     */
    const s = await setUp(harness(), { withDemo: true });
    const before = (await s.h.run((ctx) => ctx.db.query("sites").first()))!;
    expect(before.demoExpiresAt).toBeDefined();

    await convert(s);

    const after = (await s.h.run((ctx) => ctx.db.query("sites").first()))!;
    expect(after.demoExpiresAt).toBeUndefined();
    expect(after.isDemo).toBe(false);
    expect(after.status).toBe("live");
    expect(after.publishedConfig).toBeDefined();
  });

  test("and the promoted site actually resolves to the public", async () => {
    const s = await setUp(harness(), { withDemo: true });
    const result = await convert(s);

    const resolved = await s.h.query(api.public.site.resolve, { slug: result.slug });
    /*
     * "site", not "holding". An expired or unpublished site resolves to a
     * holding page rather than an error, so asserting the KIND is what
     * distinguishes a live client site from a polite blank one.
     */
    expect(resolved.kind).toBe("site");
    if (resolved.kind !== "site") throw new Error("unreachable");
    expect(resolved.isDemo).toBe(false);
    expect(resolved.demo).toBeNull();
  });

  test("a client with no demo gets a back office and an extra checklist row", async () => {
    // A site needs a template, a brand colour and copy. Inventing those is the
    // demo builder's job, so this says so rather than leaving it to be noticed.
    const s = await setUp(harness());
    const result = await convert(s);

    expect(result.promotedDemo).toBe(false);
    expect(result.siteId).toBeNull();

    const items = await s.h.run((ctx) => ctx.db.query("onboardingItems").collect());
    expect(items.some((i) => i.key === "build-site")).toBe(true);
  });
});

describe("what it refuses", () => {
  test("a deal that is not won", async () => {
    const s = await setUp(harness());
    const second = await s.owner.mutation(api.queue.disposition, {
      leadId: await s.h.run((ctx) =>
        ctx.db.insert("leads", {
          ventureId: s.ventureId, businessName: "Другой", niche: "solar",
          phone: "+27825559999", auditFaults: [], status: "working",
          provenance: {
            source: "referral", capturedAt: SEP, lawfulBasis: "consent",
          },
        }),
      ),
      outcome: "meeting_set",
      now: SEP,
    });

    await expect(
      convert(s, { dealId: second.dealId! }),
    ).rejects.toThrow(/DEAL_NOT_WON/);
  });

  test("AN UNCONFIRMED ISSUER, BEFORE ANYTHING IS WRITTEN", async () => {
    /*
     * issueInvoiceFor refuses an unconfirmed issuer and runs last, so without
     * the early check the whole transaction rolls back at the final step and
     * reports an invoicing problem for what looked like an onboarding action.
     */
    const s = await setUp(harness(), { confirmIssuer: false });

    await expect(convert(s)).rejects.toThrow(/ISSUER_UNCONFIRMED/);

    // And nothing was left behind.
    expect(await s.h.run((ctx) => ctx.db.query("clients").collect())).toEqual([]);
    expect(await s.h.run((ctx) => ctx.db.query("invites").collect())).toEqual([]);
    expect(await s.h.run((ctx) => ctx.db.query("onboardingItems").collect())).toEqual([]);
    const lead = (await s.h.run((ctx) => ctx.db.get(s.leadId)))!;
    expect(lead.status).not.toBe("converted");
  });

  test("CONVERTING TWICE DOES NOT MINT A SECOND EVERYTHING", async () => {
    // A double click must not produce two clients, two invites and two
    // invoices for one customer.
    const s = await setUp(harness());
    const first = await convert(s);
    const again = await convert(s);

    expect(again.alreadyConverted).toBe(true);
    expect(again.clientId).toBe(first.clientId);

    expect(await s.h.run((ctx) => ctx.db.query("clients").collect())).toHaveLength(1);
    expect(await s.h.run((ctx) => ctx.db.query("invites").collect())).toHaveLength(1);
    expect(await s.h.run((ctx) => ctx.db.query("invoices").collect())).toHaveLength(1);
  });

  test("a blank owner email — the invite would be unusable", async () => {
    const s = await setUp(harness());
    await expect(convert(s, { ownerEmail: "  " })).rejects.toThrow(/cannot be blank/);
  });

  test("a client owner is not platform staff", async () => {
    const s = await setUp(harness());
    const tenantUser = await s.h.run(async (ctx) => {
      const clientId = await ctx.db.insert("clients", {
        ventureId: s.ventureId, kind: "platform", name: "Alpha", slug: "alpha",
        status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      });
      const userId = await ctx.db.insert("users", { email: "owner@alpha.test" });
      await ctx.db.insert("memberships", {
        userId, clientId, role: "owner", active: true, acceptedAt: SEP,
      });
      return userId;
    });

    await expect(
      s.h
        .withIdentity({ subject: `${tenantUser}|test-session` })
        .mutation(api.onboarding.convertWonDeal, {
          dealId: s.dealId, ownerEmail: "x@y.test", now: SEP,
        }),
    ).rejects.toThrow(/platform access/);
  });
});

describe("the money lands where it should", () => {
  test("issuing is a RECEIVABLE, not revenue — the P&L is cash basis", async () => {
    /*
     * Counting the issue and the payment against it would report every job
     * twice. See REVENUE_TYPES in lib/ledger.ts.
     */
    const s = await setUp(harness());
    await convert(s);

    const entries = await s.h.run((ctx) => ctx.db.query("ledgerEntries").collect());
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("invoice_issued");

    /*
     * income.summary returns one row per currency of RECEIVED money. An
     * issued invoice is a receivable, so there is nothing for it to report —
     * an empty list, not a zero. Counting the issue and the payment against
     * it would report every job twice.
     */
    const income = await s.owner.query(api.income.summary, { ventureId: s.ventureId });
    expect(income).toEqual([]);
  });

  test("the invoice belongs to the client that was just created", async () => {
    const s = await setUp(harness());
    const result = await convert(s);

    const invoice = (await s.h.run((ctx) => ctx.db.query("invoices").first()))!;
    expect(invoice.clientId).toBe(result.clientId);
    expect(invoice.status).toBe("issued");
    expect(invoice.isDemo).toBe(false);
  });
});
