import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * EXPENSES — the cost side of a per-venture P&L.
 *
 * The guarantee worth testing is not that a row saves. It is that a figure
 * cannot land in the wrong venture's P&L without anyone noticing: a cost
 * booked to venture A but attributed to venture B's client still adds up,
 * still errors nowhere, and makes every per-venture number quietly wrong.
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

const expense = (ventureId: Id<"ventures">, over: Record<string, unknown> = {}) => ({
  ventureId,
  description: "Fibre line",
  category: "Connectivity",
  amountCents: 129900,
  currency: "ZAR" as const,
  incurredAt: JAN,
  ...over,
});

describe("recording an expense", () => {
  test("stores whole cents beside its currency", async () => {
    const { h, owner, consulting } = await setup();
    const { expenseId } = await owner.mutation(api.expenses.create, expense(consulting));

    const row = await h.run((ctx) => ctx.db.get(expenseId));
    expect(row?.amountCents).toBe(129900);
    expect(row?.currency).toBe("ZAR");
    expect(row?.recurring).toBe(false);
  });

  test("REFUSES a fractional cent", async () => {
    // A parsed "1299.5" is how a ledger acquires a figure that never reconciles.
    const { owner, consulting } = await setup();
    await expect(
      owner.mutation(api.expenses.create, expense(consulting, { amountCents: 1299.5 })),
    ).rejects.toThrow(/BAD_MONEY/);
  });

  test("refuses zero and negative amounts", async () => {
    const { owner, consulting } = await setup();
    for (const amountCents of [0, -500]) {
      await expect(
        owner.mutation(api.expenses.create, expense(consulting, { amountCents })),
      ).rejects.toThrow(/BAD_MONEY/);
    }
  });

  test("refuses a client that belongs to a DIFFERENT venture", async () => {
    /*
     * The whole point. Without this the cost sits in Consulting's P&L while
     * pointing at a Property client — arithmetic intact, attribution wrong,
     * nothing raised.
     */
    const { owner, consulting, property } = await setup();
    const { clientId } = await owner.mutation(api.clients.createExternal, {
      ventureId: property, name: "Salt Rock Cottage", currency: "ZAR",
    });

    await expect(
      owner.mutation(api.expenses.create, expense(consulting, { clientId })),
    ).rejects.toThrow(/CLIENT_VENTURE_MISMATCH/);
  });

  test("accepts a client that does belong to the venture", async () => {
    const { owner, consulting } = await setup();
    const { clientId } = await owner.mutation(api.clients.createExternal, {
      ventureId: consulting, name: "Zenith Freight", currency: "ZAR",
    });

    await expect(
      owner.mutation(api.expenses.create, expense(consulting, { clientId })),
    ).resolves.toMatchObject({ currency: "ZAR" });
  });

  test("allows a currency other than the venture's", async () => {
    // Buying a tool in USD for a ZAR venture is ordinary; per-currency
    // totals are what make it safe.
    const { owner, consulting } = await setup();
    await expect(
      owner.mutation(api.expenses.create, expense(consulting, { currency: "USD" })),
    ).resolves.toMatchObject({ currency: "USD" });
  });

  test("an operator cannot record one", async () => {
    const { h, owner, consulting } = await setup();
    void owner;
    const operatorId = await h.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "op@thecreativecurrent.co.za" });
      await ctx.db.insert("platformMembers", { userId, role: "operator", active: true });
      return userId;
    });

    await expect(
      asUser(h, operatorId).mutation(api.expenses.create, expense(consulting)),
    ).rejects.toThrow();
  });

  test("is audit-logged against its venture and client", async () => {
    const { h, owner, consulting } = await setup();
    const { clientId } = await owner.mutation(api.clients.createExternal, {
      ventureId: consulting, name: "Zenith Freight", currency: "ZAR",
    });
    await owner.mutation(api.expenses.create, expense(consulting, { clientId }));

    const entries = await h.run((ctx) => ctx.db.query("auditLog").collect());
    const logged = entries.find((e) => e.action === "expense.create");
    expect(logged?.ventureId).toBe(consulting);
    expect(logged?.clientId).toBe(clientId);
  });
});

describe("totals", () => {
  test("reports PER CURRENCY and never sums across them", async () => {
    const { owner, consulting } = await setup();
    await owner.mutation(api.expenses.create, expense(consulting, { amountCents: 100_00 }));
    await owner.mutation(api.expenses.create, expense(consulting, { amountCents: 250_00 }));
    await owner.mutation(
      api.expenses.create,
      expense(consulting, { amountCents: 40_00, currency: "USD" }),
    );

    const rows = await owner.query(api.expenses.summary, { ventureId: consulting });
    expect(rows).toHaveLength(2);

    const zar = rows.find((r) => r.currency === "ZAR");
    const usd = rows.find((r) => r.currency === "USD");
    expect(zar?.totalCents).toBe(350_00);
    expect(usd?.totalCents).toBe(40_00);
    // And crucially: no row anywhere holds 390_00.
    expect(rows.some((r) => r.totalCents === 390_00)).toBe(false);
  });

  test("groups by category, largest first", async () => {
    const { owner, consulting } = await setup();
    await owner.mutation(api.expenses.create, expense(consulting, { category: "Software", amountCents: 50_00 }));
    await owner.mutation(api.expenses.create, expense(consulting, { category: "Connectivity", amountCents: 300_00 }));
    await owner.mutation(api.expenses.create, expense(consulting, { category: "Software", amountCents: 25_00 }));

    const [zar] = await owner.query(api.expenses.summary, { ventureId: consulting });
    expect(zar!.categories[0]).toMatchObject({ category: "Connectivity", totalCents: 300_00 });
    expect(zar!.categories[1]).toMatchObject({ category: "Software", totalCents: 75_00, count: 2 });
  });

  test("keeps ventures apart", async () => {
    const { owner, consulting, property } = await setup();
    await owner.mutation(api.expenses.create, expense(consulting, { amountCents: 100_00 }));
    await owner.mutation(api.expenses.create, expense(property, { amountCents: 900_00 }));

    const [c] = await owner.query(api.expenses.summary, { ventureId: consulting });
    const [p] = await owner.query(api.expenses.summary, { ventureId: property });
    expect(c!.totalCents).toBe(100_00);
    expect(p!.totalCents).toBe(900_00);

    // Unfiltered still sees both, in one ZAR row.
    const [all] = await owner.query(api.expenses.summary, {});
    expect(all!.totalCents).toBe(1000_00);
  });

  test("honours a date window", async () => {
    const { owner, consulting } = await setup();
    await owner.mutation(api.expenses.create, expense(consulting, { amountCents: 100_00, incurredAt: JAN }));
    await owner.mutation(api.expenses.create, expense(consulting, { amountCents: 700_00, incurredAt: FEB }));

    const [feb] = await owner.query(api.expenses.summary, {
      ventureId: consulting,
      since: Date.UTC(2026, 1, 1),
    });
    expect(feb!.totalCents).toBe(700_00);
    expect(feb!.count).toBe(1);
  });

  test("an empty venture reports nothing rather than a zero row", async () => {
    // A zero total invites "we spent nothing"; no rows says "nothing recorded".
    const { owner, property } = await setup();
    await expect(
      owner.query(api.expenses.summary, { ventureId: property }),
    ).resolves.toEqual([]);
  });
});

describe("the expense list", () => {
  test("is newest first and carries venture and client names", async () => {
    const { owner, consulting } = await setup();
    const { clientId } = await owner.mutation(api.clients.createExternal, {
      ventureId: consulting, name: "Zenith Freight", currency: "ZAR",
    });
    await owner.mutation(api.expenses.create, expense(consulting, { description: "Older", incurredAt: JAN }));
    await owner.mutation(
      api.expenses.create,
      expense(consulting, { description: "Newer", incurredAt: FEB, clientId }),
    );

    const rows = await owner.query(api.expenses.list, { ventureId: consulting });
    expect(rows.map((r) => r.description)).toEqual(["Newer", "Older"]);
    expect(rows[0]).toMatchObject({
      ventureName: "Consulting",
      clientName: "Zenith Freight",
    });
    expect(rows[1]!.clientName).toBeNull();
  });
});
