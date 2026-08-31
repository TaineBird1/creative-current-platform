import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * MANUAL INCOME — the revenue side before the invoice engine exists.
 *
 * It writes into `ledgerEntries` rather than a parallel table, so M5 adds rows
 * beside these instead of replacing them. The tests that matter are the ones
 * that keep a P&L honest: money cannot land in the wrong venture, currencies
 * are never summed, and a correction is an entry rather than an edit.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

async function withOwner(h: Harness) {
  const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
    email: "owner@thecreativecurrent.co.za",
  });
  return asUser(h, userId);
}

const JAN = Date.UTC(2026, 0, 15);
const FEB = Date.UTC(2026, 1, 15);

async function setup() {
  const h = harness();
  const owner = await withOwner(h);
  const { ventureId: consulting } = await owner.mutation(api.ventures.create, {
    name: "Consulting", type: "consulting", currency: "ZAR",
  });
  const { ventureId: property } = await owner.mutation(api.ventures.create, {
    name: "Property", type: "property", currency: "ZAR",
  });
  return { h, owner, consulting, property };
}

const income = (ventureId: Id<"ventures">, over: Record<string, unknown> = {}) => ({
  ventureId,
  type: "payment_received" as const,
  description: "Retainer, January",
  amountCents: 1500000,
  currency: "ZAR" as const,
  occurredAt: JAN,
  ...over,
});

describe("recording income", () => {
  test("writes a ledger entry, not a parallel table", async () => {
    // M5's invoice engine writes here too. A separate table would have had to
    // be reconciled against the real ledger forever.
    const { h, owner, consulting } = await setup();
    const { entryId } = await owner.mutation(api.income.record, income(consulting));

    const row = await h.run((ctx) => ctx.db.get(entryId));
    expect(row?.amountCents).toBe(1500000);
    expect(row?.currency).toBe("ZAR");
    expect(row?.type).toBe("payment_received");
    expect(row?.createdBy).toBeTruthy();
  });

  test("refuses fractional cents, zero and negatives", async () => {
    const { owner, consulting } = await setup();
    for (const amountCents of [1500.5, 0, -100]) {
      await expect(
        owner.mutation(api.income.record, income(consulting, { amountCents })),
      ).rejects.toThrow(/BAD_MONEY/);
    }
  });

  test("refuses a client from a DIFFERENT venture", async () => {
    /*
     * Revenue booked to one venture while pointing at another's client makes
     * every per-venture figure wrong in the direction that flatters whichever
     * venture was picked. Same invariant as expenses, same reason.
     */
    const { owner, consulting, property } = await setup();
    const { clientId } = await owner.mutation(api.clients.createExternal, {
      ventureId: property, name: "Salt Rock Cottage", currency: "ZAR",
    });

    await expect(
      owner.mutation(api.income.record, income(consulting, { clientId })),
    ).rejects.toThrow(/CLIENT_VENTURE_MISMATCH/);
  });

  test("an operator cannot record income", async () => {
    const { h, consulting } = await setup();
    const operatorId = await h.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "op@thecreativecurrent.co.za" });
      await ctx.db.insert("platformMembers", { userId, role: "operator", active: true });
      return userId;
    });

    await expect(
      asUser(h, operatorId).mutation(api.income.record, income(consulting)),
    ).rejects.toThrow();
  });
});

describe("corrections are entries, not edits", () => {
  test("a reversal negates the original and points at it", async () => {
    const { h, owner, consulting } = await setup();
    const { entryId } = await owner.mutation(api.income.record, income(consulting));

    const { reversalId, amountCents } = await owner.mutation(api.income.reverse, {
      entryId, reason: "Paid into the wrong venture",
    });
    expect(amountCents).toBe(-1500000);

    const reversal = await h.run((ctx) => ctx.db.get(reversalId));
    expect(reversal?.reversesEntryId).toBe(entryId);

    // The original is untouched — that is what append-only means.
    const original = await h.run((ctx) => ctx.db.get(entryId));
    expect(original?.amountCents).toBe(1500000);
  });

  test("a reversal nets the total to zero rather than deleting history", async () => {
    const { owner, consulting } = await setup();
    const { entryId } = await owner.mutation(api.income.record, income(consulting));
    await owner.mutation(api.income.reverse, { entryId, reason: "Duplicate" });

    const [zar] = await owner.query(api.income.summary, { ventureId: consulting });
    expect(zar!.totalCents).toBe(0);
    // Both rows still exist. A reader can see the correction happened.
    expect(zar!.count).toBe(2);
  });

  test("refuses to reverse twice, or to reverse a reversal", async () => {
    const { owner, consulting } = await setup();
    const { entryId } = await owner.mutation(api.income.record, income(consulting));
    const { reversalId } = await owner.mutation(api.income.reverse, {
      entryId, reason: "Duplicate",
    });

    await expect(
      owner.mutation(api.income.reverse, { entryId, reason: "again" }),
    ).rejects.toThrow(/ALREADY_REVERSED/);

    await expect(
      owner.mutation(api.income.reverse, { entryId: reversalId, reason: "nope" }),
    ).rejects.toThrow(/ALREADY_A_REVERSAL/);
  });
});

describe("totals", () => {
  test("per currency, never summed across", async () => {
    const { owner, consulting } = await setup();
    await owner.mutation(api.income.record, income(consulting, { amountCents: 100_00 }));
    await owner.mutation(api.income.record, income(consulting, { amountCents: 250_00 }));
    await owner.mutation(
      api.income.record,
      income(consulting, { amountCents: 40_00, currency: "USD" }),
    );

    const rows = await owner.query(api.income.summary, { ventureId: consulting });
    expect(rows.find((r) => r.currency === "ZAR")?.totalCents).toBe(350_00);
    expect(rows.find((r) => r.currency === "USD")?.totalCents).toBe(40_00);
    expect(rows.some((r) => r.totalCents === 390_00)).toBe(false);
  });

  test("an empty venture reports nothing, not a zero", async () => {
    // The whole reason this module exists: a zero reads as "you earned
    // nothing", which is a stronger and more wrong claim than "not tracked".
    const { owner, property } = await setup();
    await expect(
      owner.query(api.income.summary, { ventureId: property }),
    ).resolves.toEqual([]);
  });

  test("honours a period window", async () => {
    const { owner, consulting } = await setup();
    await owner.mutation(api.income.record, income(consulting, { amountCents: 100_00, occurredAt: JAN }));
    await owner.mutation(api.income.record, income(consulting, { amountCents: 700_00, occurredAt: FEB }));

    const [feb] = await owner.query(api.income.summary, {
      ventureId: consulting,
      since: Date.UTC(2026, 1, 1),
      until: Date.UTC(2026, 1, 28),
    });
    expect(feb!.totalCents).toBe(700_00);
  });

  test("ignores non-income ledger rows", async () => {
    /*
     * The ledger holds commissions, write-offs and expense mirrors too. If
     * those leaked into revenue the P&L would double-count the moment M5
     * starts writing.
     */
    const { h, owner, consulting } = await setup();
    await owner.mutation(api.income.record, income(consulting, { amountCents: 500_00 }));
    await h.run(async (ctx) => {
      await ctx.db.insert("ledgerEntries", {
        ventureId: consulting,
        type: "commission_accrued",
        amountCents: 999_00,
        currency: "ZAR",
        occurredAt: JAN,
        description: "Agent commission",
      });
    });

    const [zar] = await owner.query(api.income.summary, { ventureId: consulting });
    expect(zar!.totalCents).toBe(500_00);
    expect(zar!.count).toBe(1);
  });
});

describe("the P&L composition", () => {
  test("nets revenue against expenses, per venture, per currency", async () => {
    const { owner, consulting } = await setup();
    await owner.mutation(api.income.record, income(consulting, { amountCents: 1000_00 }));
    await owner.mutation(api.expenses.create, {
      ventureId: consulting, description: "Fibre", category: "Connectivity",
      amountCents: 300_00, currency: "ZAR", incurredAt: JAN,
    });

    const pnl = await owner.query(api.finance.pnl, { ventureId: consulting });
    const zar = pnl.ventures[0]!.currencies.find((c) => c.currency === "ZAR");
    expect(zar).toMatchObject({ revenueCents: 1000_00, expenseCents: 300_00, netCents: 700_00 });
  });

  test("shows a venture that only SPENT — the normal first month", async () => {
    // Deriving the currency list from income alone would hide this venture.
    const { owner, property } = await setup();
    await owner.mutation(api.expenses.create, {
      ventureId: property, description: "Linen", category: "Turnover",
      amountCents: 250_00, currency: "ZAR", incurredAt: JAN,
    });

    const pnl = await owner.query(api.finance.pnl, { ventureId: property });
    const zar = pnl.ventures[0]!.currencies.find((c) => c.currency === "ZAR");
    expect(zar).toMatchObject({ revenueCents: 0, expenseCents: 250_00, netCents: -250_00 });
  });

  test("declares what is NOT tracked, so a zero is never mistaken for a fact", async () => {
    const { owner, consulting } = await setup();
    const pnl = await owner.query(api.finance.pnl, { ventureId: consulting });
    const keys = pnl.notTracked.map((l) => l.key);
    expect(keys).toContain("invoiced");
    expect(keys).toContain("subscriptions");
    expect(keys).toContain("commissions");
    for (const line of pnl.notTracked) expect(line.reason).toMatch(/M\d/);
  });

  test("combines across ventures but never across currencies", async () => {
    const { owner, consulting, property } = await setup();
    await owner.mutation(api.income.record, income(consulting, { amountCents: 100_00 }));
    await owner.mutation(api.income.record, income(property, { amountCents: 400_00 }));
    await owner.mutation(api.income.record, income(consulting, { amountCents: 50_00, currency: "USD" }));

    const pnl = await owner.query(api.finance.pnl, {});
    expect(pnl.combined.find((c) => c.currency === "ZAR")?.revenueCents).toBe(500_00);
    expect(pnl.combined.find((c) => c.currency === "USD")?.revenueCents).toBe(50_00);
    expect(pnl.combined.some((c) => c.revenueCents === 550_00)).toBe(false);
  });

  test("a period window bounds both sides", async () => {
    const { owner, consulting } = await setup();
    await owner.mutation(api.income.record, income(consulting, { amountCents: 900_00, occurredAt: JAN }));
    await owner.mutation(api.income.record, income(consulting, { amountCents: 100_00, occurredAt: FEB }));
    await owner.mutation(api.expenses.create, {
      ventureId: consulting, description: "Old", category: "Misc",
      amountCents: 500_00, currency: "ZAR", incurredAt: JAN,
    });

    const pnl = await owner.query(api.finance.pnl, {
      ventureId: consulting, since: Date.UTC(2026, 1, 1), until: Date.UTC(2026, 1, 28),
    });
    const zar = pnl.ventures[0]!.currencies.find((c) => c.currency === "ZAR");
    expect(zar).toMatchObject({ revenueCents: 100_00, expenseCents: 0, netCents: 100_00 });
  });
});
