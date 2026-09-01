import { v, ConvexError } from "convex/values";
import { platformMutation, platformQuery } from "./lib/functions";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { byDesc } from "./lib/ordering";

/**
 * THE PIPELINE — what happens between "they took the meeting" and "they paid".
 *
 * A deal exists to answer one question honestly: what is actually coming in.
 * Every rule here defends that answer against the ways a pipeline usually
 * lies to its owner.
 *
 * PROBABILITY IS DERIVED FROM THE STAGE, never typed in. A forecast whose
 * inputs can be nudged is a mood, not a number — and the person nudging is
 * the same person the forecast is meant to discipline. The figures below are
 * a CONVENTION, not a measurement: nothing here has closed yet, so there is
 * no observed conversion rate to use. They should be replaced by real rates
 * once there are enough closed deals to compute them, and until then they are
 * honest only in the weak sense that they are consistent.
 *
 * WON AND LOST ARE TERMINAL. A prospect who comes back gets a NEW deal.
 * Reopening a closed one rewrites the history the forecast is derived from —
 * the month it closed, the reason it was lost, how long it took — and those
 * are the only things that will ever let the conventions above be replaced by
 * measurements.
 *
 * WON IS NOT CONVERTED. Won means they said yes. Converted means a client
 * exists, with a site and a back office and an invoice. The onboarding
 * transaction that does that is not built, so `won` records the outcome and
 * says plainly that conversion is still owed. `leads.convertedClientId` stays
 * empty until something actually mints a client — a lead marked converted
 * with no client behind it is a lie that would quietly corrupt the funnel.
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

export type DealStage = Doc<"deals">["stage"];

/**
 * Stage → probability. A convention, stated once, applied everywhere.
 *
 * `lost` is 0 and `won` is 1 so that a weighted total over ALL deals equals
 * the weighted total over open ones plus what has actually closed — which
 * means the same sum can answer "what is coming" and "what came" without a
 * second code path deciding which deals to include.
 */
const PROBABILITY: Record<DealStage, number> = {
  demo_booked: 0.1,
  demo_completed: 0.25,
  pricing_presented: 0.5,
  verbal_commit: 0.8,
  won: 1,
  lost: 0,
};

const OPEN_STAGES = ["demo_booked", "demo_completed", "pricing_presented", "verbal_commit"] as const;
const isOpen = (stage: DealStage) => (OPEN_STAGES as readonly string[]).includes(stage);

export const STAGE_ORDER = [
  "demo_booked", "demo_completed", "pricing_presented", "verbal_commit", "won", "lost",
] as const;

const stageValidator = v.union(
  v.literal("demo_booked"),
  v.literal("demo_completed"),
  v.literal("pricing_presented"),
  v.literal("verbal_commit"),
  v.literal("won"),
  v.literal("lost"),
);

/** The one open deal for this lead, if there is one. */
export async function openDealForLead(
  ctx: MutationCtx,
  leadId: Id<"leads">,
): Promise<Doc<"deals"> | null> {
  const deals = await ctx.db
    .query("deals")
    .withIndex("by_lead", (q) => q.eq("leadId", leadId))
    .collect();
  return deals.find((deal) => isOpen(deal.stage)) ?? null;
}

/**
 * Open a deal for a lead. Called by the call queue when a meeting is set —
 * the disposition that means "this is now a real opportunity".
 *
 * IDEMPOTENT on the open deal. Phoning a prospect twice and setting a second
 * meeting is normal and must not produce a second deal: two rows for one
 * conversation would double the forecast, which is the exact failure this
 * whole module is shaped to avoid.
 */
export async function openDeal(
  ctx: MutationCtx,
  args: { leadId: Id<"leads">; now: number },
): Promise<{ dealId: Id<"deals">; created: boolean }> {
  const existing = await openDealForLead(ctx, args.leadId);
  if (existing) return { dealId: existing._id, created: false };

  const lead = await ctx.db.get(args.leadId);
  if (!lead) throw bad("NOT_FOUND", "No such lead.");

  const venture = await ctx.db.get(lead.ventureId);

  const dealId = await ctx.db.insert("deals", {
    ventureId: lead.ventureId,
    leadId: args.leadId,
    stage: "demo_booked",
    // No price has been discussed yet, and pretending otherwise would put a
    // number into the forecast that nobody has said out loud.
    valueCents: 0,
    currency: venture?.currency ?? "ZAR",
    probability: PROBABILITY.demo_booked,
  });

  return { dealId, created: true };
}

/**
 * Move a deal along. The stage is the claim; this is where each claim has to
 * carry whatever makes it true.
 */
export const advance = platformMutation({
  args: {
    dealId: v.id("deals"),
    stage: stageValidator,
    /** Required when moving to pricing_presented. Whole cents. */
    valueCents: v.optional(v.number()),
    /** Required when moving to lost. */
    lossReason: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const deal = await ctx.db.get(args.dealId);
    if (!deal) throw bad("NOT_FOUND", "No such deal.");

    const now = args.now ?? Date.now();

    /*
     * A closed deal stays closed. The alternative — reopening — silently
     * rewrites when it closed and why, and those are the only facts that will
     * ever let the probability conventions in this file be replaced by
     * measured rates. A prospect who returns is a new deal.
     */
    if (!isOpen(deal.stage)) {
      throw bad(
        "DEAL_IS_CLOSED",
        `This deal was already ${deal.stage}. A prospect who came back gets a new deal, ` +
          "so the month it closed and the reason stay true.",
      );
    }

    /*
     * Claiming you presented pricing without recording what you presented
     * leaves a deal that inflates the count and contributes nothing to the
     * forecast — the worst of both. The stage that asserts a number carries
     * it.
     */
    const valueCents = args.valueCents ?? deal.valueCents;
    if (args.stage === "pricing_presented" && valueCents <= 0) {
      throw bad(
        "PRICING_NEEDS_A_NUMBER",
        "Recording that pricing was presented needs the price. What did you quote?",
      );
    }
    if (!Number.isInteger(valueCents) || valueCents < 0) {
      throw bad("BAD_MONEY", "A deal value must be whole cents, and not negative.");
    }

    /*
     * A loss reason is mandatory HERE rather than in the form, because the
     * form is not the only caller and the reason is the entire reason to
     * record a loss at all. "Lost" with no why teaches nothing.
     */
    const lossReason = args.lossReason?.trim();
    if (args.stage === "lost" && !lossReason) {
      throw bad(
        "LOSS_NEEDS_A_REASON",
        "Why was it lost? A loss with no reason is a row nobody will ever learn from.",
      );
    }

    await ctx.db.patch(args.dealId, {
      stage: args.stage,
      valueCents,
      probability: PROBABILITY[args.stage],
      lossReason: args.stage === "lost" ? lossReason : undefined,
      closedAt: isOpen(args.stage) ? undefined : now,
    });

    /*
     * WON DOES NOT MARK THE LEAD CONVERTED. Converted means a client exists —
     * a site, a back office, an invoice — and the onboarding transaction that
     * creates one is not built. Setting `status: "converted"` here would put
     * a lead in the funnel's final column with nothing behind it, and every
     * count downstream would be wrong in the direction that flatters us.
     */
    return {
      stage: args.stage,
      conversionOwed: args.stage === "won",
    };
  },
});

/**
 * The board. Stages with their deals, counts, and weighted value.
 *
 * Weighted value is COMPUTED here rather than stored, because it is a product
 * of two things that both change; storing it would create a third that can
 * disagree with them.
 */
export const board = platformQuery({
  args: { includeClosed: v.optional(v.boolean()) },
  handler: async (ctx, { includeClosed }) => {
    const deals = await ctx.db.query("deals").collect();
    const visible = includeClosed ? deals : deals.filter((deal) => isOpen(deal.stage));

    const leads = new Map<string, Doc<"leads">>();
    for (const deal of visible) {
      if (leads.has(deal.leadId)) continue;
      const lead = await ctx.db.get(deal.leadId);
      if (lead) leads.set(deal.leadId, lead);
    }

    const rows = visible
      // A tie here only orders a list, so `_id` is the right tie-break —
      // see lib/ordering.ts.
      .sort(byDesc((deal) => deal._creationTime))
      .map((deal) => ({
        _id: deal._id,
        stage: deal.stage,
        valueCents: deal.valueCents,
        currency: deal.currency,
        probability: deal.probability,
        weightedCents: Math.round(deal.valueCents * deal.probability),
        lossReason: deal.lossReason ?? null,
        closedAt: deal.closedAt ?? null,
        businessName: leads.get(deal.leadId)?.businessName ?? "(lead removed)",
        area: leads.get(deal.leadId)?.area ?? null,
        leadId: deal.leadId,
      }));

    const stages = STAGE_ORDER.map((stage) => {
      const inStage = rows.filter((row) => row.stage === stage);
      return {
        stage,
        count: inStage.length,
        // Never summed across currencies — the totals below are per currency
        // for the same reason the ledger's are.
        totals: totalsByCurrency(inStage),
        deals: inStage,
      };
    }).filter((column) => includeClosed || isOpen(column.stage));

    return { stages, openTotals: totalsByCurrency(rows.filter((r) => isOpen(r.stage))) };
  },
});

function totalsByCurrency(
  rows: { valueCents: number; weightedCents: number; currency: string }[],
) {
  const byCurrency = new Map<string, { valueCents: number; weightedCents: number }>();
  for (const row of rows) {
    const running = byCurrency.get(row.currency) ?? { valueCents: 0, weightedCents: 0 };
    running.valueCents += row.valueCents;
    running.weightedCents += row.weightedCents;
    byCurrency.set(row.currency, running);
  }
  return [...byCurrency.entries()].map(([currency, sums]) => ({ currency, ...sums }));
}
