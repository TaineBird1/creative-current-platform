import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ownerMutation, ownerQuery } from "./lib/functions";
import { periodFor, spentThisPeriod, type Provider } from "./lib/placesBudget";
import { patchDoc } from "./lib/db";
import { assertCents } from "./lib/money";

/**
 * SEEING AND SETTING THE CAP.
 *
 * The cap lives in a table rather than a constant "because a constant is
 * invisible to whoever pays the bill" — and it shipped with no way for
 * anybody to see it or set it, which made it invisible for a different
 * reason. That is this file.
 *
 * READING IS OWNER-ONLY TOO. A spend figure is a business fact about what the
 * agency is spending on prospecting, not something an operator working the
 * queue needs, and the same person who may raise a cap is the one who should
 * be looking at what it has cost.
 *
 * NO DEFAULT CAP, ANYWHERE. `reserveSpend` refuses when no row exists and
 * that is the behaviour: setting one is a deliberate act with a number
 * somebody chose. Nothing here creates one implicitly, and there is no
 * "unlimited" value — a cap of zero refuses every call, which is a real and
 * useful setting, while an absent cap is the safe default it already was.
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

const provider = v.union(v.literal("google_places"), v.literal("google_geocoding"));

async function upsertCap(
  ctx: MutationCtx,
  args: {
    provider: Provider;
    period: string;
    capCents: number;
    currency: "ZAR" | "USD" | "EUR" | "GBP";
    unitCostCents: Record<string, number>;
    at: number;
  },
) {
  assertCents(args.capCents, "capCents");
  for (const [operation, cost] of Object.entries(args.unitCostCents)) {
    assertCents(cost, `unitCostCents.${operation}`);
    if (cost <= 0) {
      /*
       * A free operation is one the ledger cannot cap — it would add nothing
       * to the running total however many times it ran, which is the shape of
       * an uncapped loop wearing a cap's clothes.
       */
      throw bad("INVALID", `${operation} cannot cost 0. An operation with no price cannot be capped.`);
    }
  }
  if (!/^\d{4}-\d{2}$/.test(args.period)) {
    throw bad("INVALID", "period is a calendar month, like 2026-09.");
  }

  const existing = await ctx.db
    .query("spendCaps")
    .withIndex("by_provider_period", (q) =>
      q.eq("provider", args.provider).eq("period", args.period),
    )
    .unique();

  const row = {
    provider: args.provider,
    period: args.period,
    capCents: args.capCents,
    currency: args.currency,
    unitCostCents: args.unitCostCents,
    updatedAt: args.at,
  };

  if (existing) {
    /*
     * RAISED OR LOWERED IN PLACE, never by inserting a second row for the
     * same month. Two rows would make `unique()` throw in reserveSpend, which
     * refuses every call — a cap edit should not be able to switch sourcing
     * off by accident.
     */
    await patchDoc(ctx, existing._id, row);
    return { capId: existing._id, created: false };
  }
  return { capId: await ctx.db.insert("spendCaps", row), created: true };
}

/** The screen path. */
export const setCap = ownerMutation({
  args: {
    provider,
    period: v.optional(v.string()),
    capCents: v.number(),
    currency: v.union(v.literal("ZAR"), v.literal("USD"), v.literal("EUR"), v.literal("GBP")),
    unitCostCents: v.record(v.string(), v.number()),
    now: v.optional(v.number()),
  },
  handler: (ctx, args) => {
    const at = args.now ?? Date.now();
    return upsertCap(ctx, { ...args, period: args.period ?? periodFor(at), at });
  },
});

/**
 * The bootstrap path.
 *
 * The FIRST cap on a deployment cannot come from the screen, because the
 * screen is behind a sign-in and the point of setting one is to make the
 * first run possible. Internal, so nothing in a browser reaches it.
 */
export const setCapFromCli = internalMutation({
  args: {
    provider,
    period: v.optional(v.string()),
    capCents: v.number(),
    currency: v.union(v.literal("ZAR"), v.literal("USD"), v.literal("EUR"), v.literal("GBP")),
    unitCostCents: v.record(v.string(), v.number()),
    now: v.optional(v.number()),
  },
  handler: (ctx, args) => {
    const at = args.now ?? Date.now();
    return upsertCap(ctx, { ...args, period: args.period ?? periodFor(at), at });
  },
});

/**
 * What the month has cost and what is left.
 *
 * `capCents: null` means NO CAP IS SET, which is not zero and not unlimited —
 * it is the state in which sourcing refuses to run at all. Said as its own
 * value rather than folded into a number, because a screen rendering "R 0.00
 * of R 0.00" for that state would read as "spent out" rather than "never
 * configured", and those need different actions.
 */
export const status = ownerQuery({
  args: { provider, now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const at = args.now ?? Date.now();
    const period = periodFor(at);

    const cap = await ctx.db
      .query("spendCaps")
      .withIndex("by_provider_period", (q) =>
        q.eq("provider", args.provider).eq("period", period),
      )
      .unique();

    const spent = await spentThisPeriod(ctx, args.provider, at);

    return {
      period,
      capCents: cap?.capCents ?? null,
      currency: cap?.currency ?? spent?.currency ?? null,
      unitCostCents: cap?.unitCostCents ?? null,
      spentCents: spent?.cents ?? 0,
      remainingCents: cap ? Math.max(0, cap.capCents - (spent?.cents ?? 0)) : null,
      /** Said out loud: nothing will run until a cap exists. */
      willRefuse: !cap,
    };
  },
});
