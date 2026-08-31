import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { postEntry } from "./lib/ledger";

/**
 * THE LEDGER.
 *
 * Every test here is about a failure that produces a NUMBER rather than an
 * error. A refund stored with the wrong sign, money booked to the wrong
 * venture, a demo client accruing revenue — none of them throw anywhere
 * downstream, none of them break a total, and all of them make a P&L
 * confidently wrong. That is why the checks live at one choke point.
 *
 * Most of these drive the real mutations, because that is what proves a rule
 * is reachable from where a person actually types. Three reach postEntry
 * directly, and each says why: the sign check cannot currently be triggered
 * through the API — both callers normalise the sign before it — and a guard
 * that no test exercises is a guard nobody knows is broken.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

const JAN = Date.UTC(2026, 0, 15);

async function setup() {
  const h = harness();
  const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
    email: "owner@thecreativecurrent.co.za",
  });
  const owner = asUser(h, userId);
  const { ventureId } = await owner.mutation(api.ventures.create, {
    name: "Consulting",
    type: "consulting",
    currency: "ZAR",
  });
  const { ventureId: other } = await owner.mutation(api.ventures.create, {
    name: "Property",
    type: "property",
    currency: "ZAR",
  });
  return { h, owner, ventureId, other };
}

const external = async (
  s: Awaited<ReturnType<typeof setup>>,
  ventureId: Id<"ventures">,
  over: { isDemo?: boolean; isSeed?: boolean; name?: string } = {},
) => {
  const clientId = await s.h.run((ctx) =>
    ctx.db.insert("clients", {
      ventureId,
      kind: "external",
      name: over.name ?? "Salt Rock Cottage",
      status: "live",
      timezone: "Africa/Johannesburg",
      currency: "ZAR",
      featureFlags: {},
      isDemo: over.isDemo ?? false,
      isSeed: over.isSeed ?? false,
    }),
  );
  return clientId;
};

const paid = (ventureId: Id<"ventures">, over: Record<string, unknown> = {}) => ({
  ventureId,
  type: "payment_received" as const,
  description: "Retainer, January",
  amountCents: 1_500_00,
  currency: "ZAR" as const,
  occurredAt: JAN,
  ...over,
});

describe("the sign must match the type", () => {
  /*
   * The check that earns its place. Both mistakes below are silent: nothing
   * errors, every total still adds up, and the P&L is wrong by twice the
   * amount in the direction that flatters the month.
   */
  test("a refund is entered positive and stored negative", async () => {
    const s = await setup();
    const { amountCents } = await s.owner.mutation(api.ledger.refund, {
      ventureId: s.ventureId,
      amountCents: 500_00,
      currency: "ZAR",
      occurredAt: JAN,
      description: "Deposit returned",
    });
    expect(amountCents).toBe(-500_00);
  });

  test("a refund entered negative is refused, not silently doubled", async () => {
    // -500 negated is +500: it would land in the ledger as INCOME of R500,
    // for a month in which R500 went out. R1,000 of error, no warning.
    const s = await setup();
    await expect(
      s.owner.mutation(api.ledger.refund, {
        ventureId: s.ventureId,
        amountCents: -500_00,
        currency: "ZAR",
        occurredAt: JAN,
        description: "Deposit returned",
      }),
    ).rejects.toThrow(/BAD_MONEY/);
  });

  test("the choke point itself refuses a wrong-signed entry", async () => {
    /*
     * Reached directly, on purpose. Both public callers normalise the sign
     * before postEntry sees it — `refund` negates, `income.record` demands a
     * positive — so nothing in the API can currently trigger this check, and
     * a guard no test exercises is a guard nobody knows is broken.
     *
     * It is not dead code: it is the check that catches the NEXT writer, the
     * one that takes an amount straight from a bank feed or a provider
     * webhook where the sign arrives already decided by someone else.
     */
    const s = await setup();
    await expect(
      s.h.run((ctx) =>
        postEntry(ctx, {
          ventureId: s.ventureId,
          type: "refund",
          amountCents: 500_00, // positive: reads as revenue
          currency: "ZAR",
          occurredAt: JAN,
          description: "Refund with the sign the wrong way round",
        }),
      ),
    ).rejects.toThrow(/WRONG_SIGN/);
  });

  test("and refuses a payment recorded as a negative", async () => {
    // The mirror image: a refund wearing a payment's label.
    const s = await setup();
    await expect(
      s.h.run((ctx) =>
        postEntry(ctx, {
          ventureId: s.ventureId,
          type: "payment_received",
          amountCents: -500_00,
          currency: "ZAR",
          occurredAt: JAN,
          description: "Payment with the sign the wrong way round",
        }),
      ),
    ).rejects.toThrow(/WRONG_SIGN/);
  });

  test("but an adjustment may go either way, which is what it is for", async () => {
    const s = await setup();
    for (const amountCents of [250_00, -250_00]) {
      await expect(
        s.h.run((ctx) =>
          postEntry(ctx, {
            ventureId: s.ventureId,
            type: "adjustment",
            amountCents,
            currency: "ZAR",
            occurredAt: JAN,
            description: "Rounding correction from the bank statement",
          }),
        ),
      ).resolves.toBeTruthy();
    }
  });

  test("a refund reduces revenue rather than counting as a cost", async () => {
    const s = await setup();
    await s.owner.mutation(api.income.record, paid(s.ventureId));
    await s.owner.mutation(api.ledger.refund, {
      ventureId: s.ventureId,
      amountCents: 500_00,
      currency: "ZAR",
      occurredAt: JAN,
      description: "Partial refund",
    });

    const summary = await s.owner.query(api.income.summary, { ventureId: s.ventureId });
    const zar = summary.find((row) => row.currency === "ZAR");
    // R1,500 in, R500 back. Revenue is R1,000 — not R1,500 with a R500 cost,
    // which would leave the revenue line claiming income that was given back.
    expect(zar?.totalCents).toBe(1_000_00);
  });
});

describe("money cannot land in the wrong place", () => {
  test("a client from another venture is refused", async () => {
    const s = await setup();
    const clientId = await external(s, s.other);
    await expect(
      s.owner.mutation(api.income.record, paid(s.ventureId, { clientId })),
    ).rejects.toThrow(/CLIENT_VENTURE_MISMATCH/);
  });

  test("a demo client cannot accrue money", async () => {
    // A demo site exists to be clicked through by a stranger. Anything they
    // do on it is not revenue, and the block belongs at the ledger's door
    // rather than in each caller — same reasoning as the send choke point.
    const s = await setup();
    const clientId = await external(s, s.ventureId, { isDemo: true, name: "Demo Solar" });
    await expect(
      s.owner.mutation(api.income.record, paid(s.ventureId, { clientId })),
    ).rejects.toThrow(/NOT_A_REAL_CLIENT/);
  });

  test("a seeded client cannot accrue money either", async () => {
    const s = await setup();
    const clientId = await external(s, s.ventureId, { isSeed: true, name: "Seed Co" });
    await expect(
      s.owner.mutation(api.ledger.refund, {
        ventureId: s.ventureId,
        clientId,
        amountCents: 100_00,
        currency: "ZAR",
        occurredAt: JAN,
        description: "Refund",
      }),
    ).rejects.toThrow(/NOT_A_REAL_CLIENT/);
  });

  test("a zero entry is refused — it records nothing", async () => {
    const s = await setup();
    await expect(
      s.owner.mutation(api.income.record, paid(s.ventureId, { amountCents: 0 })),
    ).rejects.toThrow(/BAD_MONEY/);
  });
});

describe("corrections are entries, never edits", () => {
  test("a reversal may invert the sign that the original had to obey", async () => {
    // The sign rule would otherwise refuse every reversal of a payment.
    const s = await setup();
    const { entryId } = await s.owner.mutation(api.income.record, paid(s.ventureId));
    const { amountCents } = await s.owner.mutation(api.income.reverse, {
      entryId,
      reason: "Duplicated from the bank feed",
    });
    expect(amountCents).toBe(-1_500_00);
  });

  test("the original stays in the ledger beside its correction", async () => {
    const s = await setup();
    const { entryId } = await s.owner.mutation(api.income.record, paid(s.ventureId));
    await s.owner.mutation(api.income.reverse, { entryId, reason: "Duplicate" });

    const rows = await s.owner.query(api.income.list, { ventureId: s.ventureId });
    // Two rows, netting to nothing. An edit would have left one row and no
    // evidence that anything was ever wrong.
    expect(rows).toHaveLength(2);
    expect(rows.reduce((n, r) => n + r.amountCents, 0)).toBe(0);
  });

  test("an entry cannot be reversed twice", async () => {
    // The second reversal would subtract the amount again and invent a loss.
    const s = await setup();
    const { entryId } = await s.owner.mutation(api.income.record, paid(s.ventureId));
    await s.owner.mutation(api.income.reverse, { entryId, reason: "Duplicate" });
    await expect(
      s.owner.mutation(api.income.reverse, { entryId, reason: "Again" }),
    ).rejects.toThrow(/ALREADY_REVERSED/);
  });

  test("a reversal is dated today, not backdated over a closed month", async () => {
    const s = await setup();
    const { entryId } = await s.owner.mutation(api.income.record, paid(s.ventureId));
    await s.owner.mutation(api.income.reverse, { entryId, reason: "Duplicate" });

    const rows = await s.owner.query(api.income.list, { ventureId: s.ventureId });
    const reversal = rows.find((row) => row.description.startsWith("Reversal:"));
    // Backdating it would rewrite a period already reported on. A closed
    // month has to stay closed, which is most of the point of an append-only
    // ledger.
    expect(reversal?.occurredAt).toBeGreaterThan(JAN);
  });
});

describe("a client's ledger", () => {
  test("received and refunded are reported apart, not netted into one figure", async () => {
    const s = await setup();
    const clientId = await external(s, s.ventureId);
    await s.owner.mutation(api.income.record, paid(s.ventureId, { clientId }));
    await s.owner.mutation(api.ledger.refund, {
      ventureId: s.ventureId,
      clientId,
      amountCents: 200_00,
      currency: "ZAR",
      occurredAt: JAN,
      description: "Scope reduced",
    });

    const view = await s.owner.query(api.ledger.forClient, { clientId });
    const zar = view.totals.find((row) => row.currency === "ZAR")!;

    /*
     * A client who paid R1,500 and was refunded R200 is a different
     * relationship from one who paid R1,300. A lone net cannot tell them
     * apart, so all three numbers are reported.
     */
    expect(zar.receivedCents).toBe(1_500_00);
    expect(zar.refundedCents).toBe(200_00);
    expect(zar.netCents).toBe(1_300_00);
  });

  test("currencies are never summed together", async () => {
    const s = await setup();
    const clientId = await external(s, s.ventureId);
    await s.owner.mutation(api.income.record, paid(s.ventureId, { clientId }));
    await s.owner.mutation(
      api.income.record,
      paid(s.ventureId, { clientId, currency: "USD", amountCents: 100_00 }),
    );

    const view = await s.owner.query(api.ledger.forClient, { clientId });
    expect(view.totals.map((row) => row.currency).sort()).toEqual(["USD", "ZAR"]);
    expect(view.totals.find((row) => row.currency === "ZAR")?.netCents).toBe(1_500_00);
    expect(view.totals.find((row) => row.currency === "USD")?.netCents).toBe(100_00);
  });

  test("it says receivables are not tracked rather than reporting zero", async () => {
    /*
     * The same judgement as the P&L's "not tracked". A screen showing totals
     * and no mention of receivables invites the reader to assume the net IS
     * what they are owed — and nothing is owed, because nothing has ever been
     * issued.
     */
    const s = await setup();
    const clientId = await external(s, s.ventureId);
    const view = await s.owner.query(api.ledger.forClient, { clientId });
    expect(view.receivables).toMatch(/not tracked/);
    expect(view).not.toHaveProperty("outstandingCents");
  });
});
