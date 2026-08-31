import { v, ConvexError } from "convex/values";
import { byDesc } from "./lib/ordering";
import { ownerMutation, platformQuery } from "./lib/functions";
import { currency } from "./tables/tenants";
import { assertCents, sumCents, type Currency } from "./lib/money";

/**
 * EXPENSES — the cost side of a per-venture P&L (Part 5.4).
 *
 * Revenue answers half of "what is each thing actually making me". This is
 * the other half, and until the invoice engine lands in M5 it is the only
 * half with real numbers in it.
 *
 * Every expense carries a venture. Optionally a client, and later a property
 * unit — a cleaning turnover belongs to a unit, a contractor's day belongs to
 * a consulting client, and neither is meaningful without the venture above it.
 *
 * Money rules are not restated here; they are enforced by `lib/money.ts`,
 * which is the one place every financial write passes through.
 */

export const create = ownerMutation({
  args: {
    ventureId: v.id("ventures"),
    clientId: v.optional(v.id("clients")),
    description: v.string(),
    category: v.string(),
    amountCents: v.number(),
    currency,
    incurredAt: v.number(),
    vendor: v.optional(v.string()),
    recurring: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const description = args.description.trim();
    const category = args.category.trim();
    if (!description) {
      throw new ConvexError({ code: "INVALID", message: "An expense needs a description." });
    }
    if (!category) {
      throw new ConvexError({ code: "INVALID", message: "An expense needs a category." });
    }

    /*
     * Integer cents, asserted rather than trusted. A parsed "12.5" or a
     * percentage applied without rounding is exactly how a ledger acquires a
     * fractional cent that never reconciles.
     */
    const amountCents = assertCents(args.amountCents);
    if (amountCents <= 0) {
      throw new ConvexError({
        code: "BAD_MONEY",
        message: "An expense is a positive amount. Record a refund as its own entry.",
      });
    }

    const venture = await ctx.db.get(args.ventureId);
    if (!venture) {
      throw new ConvexError({ code: "NO_SUCH_VENTURE", message: "No such venture." });
    }

    /*
     * THE ONE THAT MATTERS: a client must belong to the venture the expense
     * is booked against. Otherwise a cost lands in one venture's P&L while
     * being attributed to another venture's client — the numbers still add
     * up, nothing errors, and every per-venture figure is quietly wrong. This
     * is the failure a portfolio P&L exists to avoid, so it is refused here.
     */
    if (args.clientId) {
      const client = await ctx.db.get(args.clientId);
      if (!client) {
        throw new ConvexError({ code: "NO_SUCH_CLIENT", message: "No such client." });
      }
      if (client.ventureId !== args.ventureId) {
        throw new ConvexError({
          code: "CLIENT_VENTURE_MISMATCH",
          message: `${client.name} does not belong to ${venture.name}.`,
        });
      }
    }

    /*
     * The expense's currency is NOT forced to the venture's. Buying a tool in
     * USD for a ZAR venture is ordinary. Totals are reported per currency and
     * never summed across them, which is what makes that safe.
     */
    const expenseId = await ctx.db.insert("expenses", {
      ventureId: args.ventureId,
      clientId: args.clientId,
      description,
      category,
      amountCents,
      currency: args.currency,
      incurredAt: args.incurredAt,
      vendor: args.vendor?.trim() || undefined,
      recurring: args.recurring ?? false,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      action: "expense.create",
      entityTable: "expenses",
      entityId: expenseId,
      ventureId: args.ventureId,
      clientId: args.clientId,
      after: { description, category, amountCents, currency: args.currency },
      at: Date.now(),
    });

    return { expenseId, amountCents, currency: args.currency };
  },
});

export const list = platformQuery({
  args: {
    ventureId: v.optional(v.id("ventures")),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, { ventureId, since, until }) => {
    const rows = ventureId
      ? await ctx.db
          .query("expenses")
          .withIndex("by_venture_incurred", (q) => q.eq("ventureId", ventureId))
          .collect()
      : await ctx.db.query("expenses").collect();

    const ventures = await ctx.db.query("ventures").collect();
    const ventureName = new Map(ventures.map((venture) => [venture._id, venture.name]));
    const clients = await ctx.db.query("clients").collect();
    const clientName = new Map(clients.map((client) => [client._id, client.name]));

    return rows
      .filter((row) => (since === undefined || row.incurredAt >= since))
      .filter((row) => (until === undefined || row.incurredAt <= until))
      .sort(byDesc((row) => row.incurredAt))
      .map((row) => ({
        _id: row._id,
        description: row.description,
        category: row.category,
        amountCents: row.amountCents,
        currency: row.currency,
        incurredAt: row.incurredAt,
        vendor: row.vendor ?? null,
        recurring: row.recurring,
        ventureId: row.ventureId,
        ventureName: ventureName.get(row.ventureId) ?? null,
        clientId: row.clientId ?? null,
        clientName: row.clientId ? (clientName.get(row.clientId) ?? null) : null,
      }));
  },
});

/**
 * Totals, PER CURRENCY. Never one number.
 *
 * A single "total spend" across currencies would require a rate, and a rate
 * baked into a stored figure is a number that silently ages. The house rule
 * is per-currency totals plus a manual-rate equivalent where a human asks for
 * one — so this returns a row per currency and lets the reader do the rest.
 */
export const summary = platformQuery({
  args: {
    ventureId: v.optional(v.id("ventures")),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, { ventureId, since, until }) => {
    const rows = ventureId
      ? await ctx.db
          .query("expenses")
          .withIndex("by_venture_incurred", (q) => q.eq("ventureId", ventureId))
          .collect()
      : await ctx.db.query("expenses").collect();

    const inWindow = rows
      .filter((row) => (since === undefined || row.incurredAt >= since))
      .filter((row) => (until === undefined || row.incurredAt <= until));

    const currencies = [...new Set(inWindow.map((row) => row.currency))].sort();

    return currencies.map((code) => {
      const forCurrency = inWindow.filter((row) => row.currency === code);

      const byCategory = new Map<string, typeof forCurrency>();
      for (const row of forCurrency) {
        const bucket = byCategory.get(row.category) ?? [];
        bucket.push(row);
        byCategory.set(row.category, bucket);
      }

      return {
        currency: code as Currency,
        count: forCurrency.length,
        // sumCents throws on a mixed-currency array, so this cannot silently
        // become a meaningless number if the filter above ever regresses.
        totalCents: sumCents(forCurrency, code as Currency),
        categories: [...byCategory.entries()]
          .map(([category, entries]) => ({
            category,
            count: entries.length,
            totalCents: sumCents(entries, code as Currency),
          }))
          // Two categories spending the same amount is ordinary, and the name
          // is the only stable thing to fall back on here.
          .sort((a, b) => b.totalCents - a.totalCents || a.category.localeCompare(b.category)),
      };
    });
  },
});
