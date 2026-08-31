import { v, ConvexError } from "convex/values";
import { byDesc } from "./lib/ordering";
import { ownerMutation, platformQuery } from "./lib/functions";
import { currency } from "./tables/tenants";
import { assertCents, sumCents, type Currency } from "./lib/money";
import { postEntry, reverseEntry, isRevenue } from "./lib/ledger";

/**
 * MANUAL INCOME — the revenue side, today.
 *
 * This writes into `ledgerEntries`, NOT a parallel table, because that is the
 * ledger the M5 invoice engine will write into. When invoicing lands it adds
 * `invoice_issued` and `payment_received` rows beside these; it does not
 * replace them and nothing here has to migrate. A separate "manual income"
 * table would have had to be reconciled against the real one forever.
 *
 * Why it exists before the engine: a P&L that shows real expenses against an
 * empty revenue column reads as "you earned nothing", which is a stronger and
 * more wrong claim than "not tracked". The data layer already refuses to
 * report a zero for a venture with no expenses; the revenue column has to
 * hold the same line, and the only way to make the net real today is to let
 * the owner record what actually came in.
 *
 * Append-only, enforced by guards.test.ts. There is no edit and no delete —
 * a mistake is corrected with `reverse`, which is what an immutable ledger
 * means in practice.
 */

/**
 * What a human may record by hand. `invoice_issued`, `commission_*` and the
 * rest belong to the engines that own them; minting one here by hand would
 * put a row in the ledger that no invoice or payout can ever reconcile to.
 */
const manualIncomeType = v.union(
  v.literal("payment_received"),
  v.literal("property_income"),
  v.literal("adjustment"),
);

/*
 * Which ledger rows count as revenue now lives in lib/ledger.ts, beside the
 * writer. It used to be defined here AND in finance.ts, which is the drift
 * this comment used to worry about: a type recorded by one and missed by the
 * other is money that exists in the ledger and never reaches a P&L.
 */

export const record = ownerMutation({
  args: {
    ventureId: v.id("ventures"),
    clientId: v.optional(v.id("clients")),
    type: manualIncomeType,
    amountCents: v.number(),
    currency,
    occurredAt: v.number(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const description = args.description.trim();
    if (!description) {
      throw new ConvexError({
        code: "INVALID",
        message: "Income needs a description — a ledger line nobody can identify is not evidence.",
      });
    }

    const amountCents = assertCents(args.amountCents);
    if (amountCents <= 0) {
      throw new ConvexError({
        code: "BAD_MONEY",
        message: "Income is a positive amount. Correct a mistake with a reversing entry.",
      });
    }

    /*
     * Everything else — whole cents, the client belonging to the venture, the
     * sign agreeing with the type, demo and seed data never accruing — is
     * enforced by postEntry, which is the only writer of ledgerEntries.
     * Repeating those checks here would be two places to forget one.
     */
    const entryId = await postEntry(ctx, {
      ventureId: args.ventureId,
      clientId: args.clientId,
      type: args.type,
      amountCents,
      currency: args.currency,
      occurredAt: args.occurredAt,
      description,
      createdBy: ctx.platform.userId,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      action: "income.record",
      entityTable: "ledgerEntries",
      entityId: entryId,
      ventureId: args.ventureId,
      clientId: args.clientId,
      after: { description, type: args.type, amountCents, currency: args.currency },
      at: Date.now(),
    });

    return { entryId, amountCents, currency: args.currency };
  },
});

/**
 * Correct a mistake by negating it, never by editing it.
 *
 * The reversal points back at what it reverses, so a statement can show both
 * and a reader can see that a correction happened rather than finding a
 * number that quietly changed.
 */
export const reverse = ownerMutation({
  args: { entryId: v.id("ledgerEntries"), reason: v.string() },
  handler: async (ctx, { entryId, reason }) => {
    const { reversalId, amountCents, original } = await reverseEntry(
      ctx,
      entryId,
      reason,
      ctx.platform.userId,
    );

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      action: "income.reverse",
      entityTable: "ledgerEntries",
      entityId: reversalId,
      ventureId: original.ventureId,
      clientId: original.clientId,
      before: { amountCents: original.amountCents, description: original.description },
      after: { amountCents, reversesEntryId: entryId },
      at: Date.now(),
    });

    return { reversalId, amountCents };
  },
});

export const list = platformQuery({
  args: {
    ventureId: v.optional(v.id("ventures")),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, { ventureId, since, until }) => {
    const all = ventureId
      ? await ctx.db
          .query("ledgerEntries")
          .withIndex("by_venture_occurred", (q) => q.eq("ventureId", ventureId))
          .collect()
      : await ctx.db.query("ledgerEntries").collect();
    const rows = all.filter((row) => isRevenue(row.type));

    const ventures = await ctx.db.query("ventures").collect();
    const ventureName = new Map(ventures.map((venture) => [venture._id as string, venture.name]));
    const clients = await ctx.db.query("clients").collect();
    const clientName = new Map(clients.map((client) => [client._id as string, client.name]));

    return rows
      .filter((row) => since === undefined || row.occurredAt >= since)
      .filter((row) => until === undefined || row.occurredAt <= until)
      .sort(byDesc((row) => row.occurredAt))
      .map((row) => ({
        _id: row._id,
        description: row.description,
        type: row.type,
        amountCents: row.amountCents,
        currency: row.currency,
        occurredAt: row.occurredAt,
        isReversal: Boolean(row.reversesEntryId),
        ventureId: row.ventureId,
        ventureName: ventureName.get(row.ventureId) ?? null,
        clientId: row.clientId ?? null,
        clientName: row.clientId ? (clientName.get(row.clientId) ?? null) : null,
      }));
  },
});

/**
 * Totals, PER CURRENCY, same rule as expenses. Reversals are included and
 * net out, which is the entire reason a correction is an entry rather than
 * an edit.
 */
export const summary = platformQuery({
  args: {
    ventureId: v.optional(v.id("ventures")),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, { ventureId, since, until }) => {
    const all = ventureId
      ? await ctx.db
          .query("ledgerEntries")
          .withIndex("by_venture_occurred", (q) => q.eq("ventureId", ventureId))
          .collect()
      : await ctx.db.query("ledgerEntries").collect();
    const rows = all.filter((row) => isRevenue(row.type));

    const inWindow = rows
      .filter((row) => since === undefined || row.occurredAt >= since)
      .filter((row) => until === undefined || row.occurredAt <= until);

    const currencies = [...new Set(inWindow.map((row) => row.currency))].sort();

    return currencies.map((code) => {
      const forCurrency = inWindow.filter((row) => row.currency === code);
      return {
        currency: code as Currency,
        count: forCurrency.length,
        totalCents: sumCents(forCurrency, code as Currency),
      };
    });
  },
});
