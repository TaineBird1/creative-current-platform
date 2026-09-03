import { v, ConvexError } from "convex/values";
import { ownerMutation, platformQuery, platformAction } from "./lib/functions";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertCents } from "./lib/money";
import { newStartReference, paystack, paystackMode } from "./lib/paystack";
import { patchDoc } from "./lib/db";

/**
 * THE MONTHLY FEE.
 *
 * The build invoice is a once-off and is issued by the onboarding transaction.
 * This is the other half of the business model, and it is the half that has to
 * keep working without anybody touching it.
 *
 * WHO CREATES A SUBSCRIPTION: not us. Paystack does, when the customer pays a
 * transaction carrying a plan code. We open the checkout and then listen. That
 * is deliberate — a subscription we created locally and one Paystack created
 * are two records of the same fact that can disagree about whether the money
 * is actually being collected, and the one that matters is theirs.
 *
 * So `start` writes a PENDING row and returns a link. Nothing is active until
 * a webhook says so, and `webhooks.ingest` is the only thing that may say it.
 *
 * THE AMOUNT COMES FROM THE PLAN, NEVER FROM THE CALLER. Same rule as a
 * quote's total and a deal's probability: a price a caller can pass is a price
 * that will eventually be passed wrongly, and this one is charged monthly to a
 * real card until somebody notices.
 *
 * WHAT IS NOT BUILT: dunning. `invoice.payment_failed` moves a subscription to
 * `past_due` and stops there — nothing chases, nothing retries, nothing
 * suspends. Suspension is explicit-only by schema, because a card declining
 * once is not a decision to cancel, and the failure of an automatic suspension
 * is a client whose site went dark over a bank glitch. It needs a human in the
 * loop and there is one.
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

/* ------------------------------------------------------------------ plans */

export const setPlan = ownerMutation({
  args: {
    ventureId: v.id("ventures"),
    key: v.string(),
    name: v.string(),
    amountCents: v.number(),
    interval: v.union(v.literal("monthly"), v.literal("annually")),
    /**
     * The plan code from Paystack's dashboard. Optional so a plan can be
     * written down before it exists there — but `start` refuses without it,
     * because a checkout with no plan code charges once and subscribes nobody.
     */
    providerPlanCode: v.optional(v.string()),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const venture = await ctx.db.get(args.ventureId);
    if (!venture) throw bad("NO_SUCH_VENTURE", "No such venture.");

    const key = args.key.trim().toLowerCase();
    const name = args.name.trim();
    if (!key || !name) throw bad("INVALID", "A plan needs a key and a name.");
    assertCents(args.amountCents, "amountCents");
    if (args.amountCents <= 0) {
      throw bad("BAD_MONEY", "A plan costs more than nothing. Use a free feature flag instead.");
    }

    const existing = await ctx.db
      .query("plans")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();

    const fields = {
      ventureId: args.ventureId,
      key,
      name,
      amountCents: args.amountCents,
      currency: venture.currency,
      interval: args.interval,
      provider: "paystack" as const,
      providerPlanCode: args.providerPlanCode?.trim() || undefined,
      active: args.active ?? true,
    };

    if (existing) {
      /*
       * EDITING A PLAN DOES NOT RE-PRICE ANYBODY. Existing subscriptions
       * snapshotted their amount when they started, exactly as an invoice
       * snapshots its issuer — a price rise applies to the next customer, not
       * to the one who already agreed a number.
       */
      await patchDoc(ctx, existing._id, fields);
      return { planId: existing._id, created: false };
    }
    return { planId: await ctx.db.insert("plans", fields), created: true };
  },
});

export const plans = platformQuery({
  args: { ventureId: v.optional(v.id("ventures")) },
  handler: async (ctx, { ventureId }) => {
    const all = await ctx.db.query("plans").collect();
    return all
      .filter((plan) => (ventureId ? plan.ventureId === ventureId : true))
      .map((plan) => ({
        _id: plan._id,
        key: plan.key,
        name: plan.name,
        amountCents: plan.amountCents,
        currency: plan.currency,
        interval: plan.interval,
        active: plan.active,
        /** Absent means it cannot be sold — see `start`. */
        sellable: Boolean(plan.providerPlanCode),
      }));
  },
});

/* ---------------------------------------------------------- starting one */

export type StartResult =
  | { ok: true; subscriptionId: Id<"subscriptions">; checkoutUrl: string; reference: string }
  | { ok: false; reason: string };

/**
 * Everything the action needs, decided inside a transaction so two clicks
 * cannot open two checkouts for one client.
 */
export const reserveStart = internalMutation({
  args: { clientSlug: v.string(), planKey: v.string(), reference: v.string() },
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("clients")
      .withIndex("by_slug", (q) => q.eq("slug", args.clientSlug.trim().toLowerCase()))
      .first();
    if (!client) throw bad("NOT_FOUND", "No such client.");

    /*
     * DEMO AND SEED DATA IS NEVER CHARGED. The same flag the ledger and the
     * messaging pipeline check, checked here too — because this is the path
     * that reaches a real card, and the demo regime exists so that a business
     * who never signed up cannot be billed by a mistake in our code.
     */
    if (client.isDemo || client.isSeed) {
      throw bad(
        "NOT_A_REAL_CLIENT",
        `${client.name} is ${client.isSeed ? "seed" : "demo"} data. It cannot be subscribed.`,
      );
    }

    const plan = await ctx.db
      .query("plans")
      .withIndex("by_key", (q) => q.eq("key", args.planKey.trim().toLowerCase()))
      .first();
    if (!plan) throw bad("NO_SUCH_PLAN", `No plan with the key "${args.planKey}".`);
    if (!plan.active) throw bad("PLAN_INACTIVE", `The plan "${plan.name}" is not being sold.`);
    if (plan.ventureId !== client.ventureId) {
      // Same rule as income and expenses: a plan billed under one venture for
      // a client belonging to another makes every per-venture figure wrong
      // while the arithmetic still adds up.
      throw bad("WRONG_VENTURE", "That plan belongs to a different venture.");
    }
    if (!plan.providerPlanCode) {
      throw bad(
        "PLAN_NOT_AT_PROVIDER",
        `"${plan.name}" has no Paystack plan code. Create the plan in Paystack first — ` +
          "a checkout without one takes a single payment and subscribes nobody.",
      );
    }
    if (!client.primaryContactEmail) {
      throw bad(
        "NO_CONTACT_EMAIL",
        `${client.name} has no contact email. Paystack keys its customer records on one, ` +
          "and the receipt goes there.",
      );
    }

    /*
     * ONE LIVE SUBSCRIPTION PER CLIENT. A second pending row is a second
     * checkout link in circulation, and if both are paid the client is billed
     * twice every month by two subscriptions neither of us is watching.
     */
    const live = (
      await ctx.db
        .query("subscriptions")
        .withIndex("by_client", (q) => q.eq("clientId", client._id))
        .collect()
    ).find((s) => s.status === "pending" || s.status === "active" || s.status === "past_due");

    if (live) {
      return {
        already: true as const,
        subscriptionId: live._id,
        status: live.status,
        clientName: client.name,
      };
    }

    const subscriptionId = await ctx.db.insert("subscriptions", {
      ventureId: client.ventureId,
      clientId: client._id,
      planId: plan._id,
      plan: plan.key,
      // SNAPSHOT. A later price rise does not re-price this client.
      amountCents: plan.amountCents,
      currency: plan.currency,
      provider: "paystack",
      startReference: args.reference,
      status: "pending",
    });

    return {
      already: false as const,
      subscriptionId,
      email: client.primaryContactEmail,
      planCode: plan.providerPlanCode,
      clientId: client._id,
      clientName: client.name,
    };
  },
});

/** Rolls the pending row back when the provider never gave us a checkout. */
export const abandonStart = internalMutation({
  args: { subscriptionId: v.id("subscriptions") },
  handler: async (ctx, { subscriptionId }) => {
    const row = await ctx.db.get(subscriptionId);
    /*
     * Only a row that never got anywhere. If a webhook has already moved it —
     * the checkout succeeded and Paystack was faster than our own response —
     * this must not undo that.
     */
    if (row?.status === "pending" && !row.providerRef) {
      await patchDoc(ctx, subscriptionId, { status: "cancelled" });
    }
  },
});

/**
 * Open a checkout. An ACTION, because it reaches the network — so the pending
 * row is written first, in its own transaction, and rolled back if Paystack
 * refuses. The alternative is calling out from inside a mutation, which Convex
 * does not allow and which would be wrong anyway: a transaction that waits on
 * somebody else's server holds its read set open for as long as they take.
 */
export const start = platformAction({
  args: { clientSlug: v.string(), planKey: v.string(), callbackUrl: v.optional(v.string()) },
  handler: async (ctx, args): Promise<StartResult> => {
    const reference = newStartReference();

    const reserved = await ctx.runMutation(internal.subscriptions.reserveStart, {
      clientSlug: args.clientSlug,
      planKey: args.planKey,
      reference,
    });

    if (reserved.already) {
      return {
        ok: false,
        reason:
          `${reserved.clientName} already has a ${reserved.status} subscription. ` +
          "Cancel it before starting another, or nobody can tell which one is billing.",
      };
    }

    const result = await paystack().initialize({
      email: reserved.email!,
      planCode: reserved.planCode!,
      reference,
      /*
       * Our own identifiers, carried through. Paystack echoes metadata on
       * transaction events, which lets a webhook say whose payment this is
       * without a lookup — and gives a second attribution route if the
       * reference is ever missing.
       */
      metadata: { clientId: reserved.clientId!, subscriptionId: reserved.subscriptionId },
      callbackUrl: args.callbackUrl,
    });

    if (!result.ok) {
      await ctx.runMutation(internal.subscriptions.abandonStart, {
        subscriptionId: reserved.subscriptionId,
      });
      return { ok: false, reason: result.error };
    }

    return {
      ok: true,
      subscriptionId: reserved.subscriptionId,
      checkoutUrl: result.authorizationUrl,
      reference: result.reference,
    };
  },
});

/* -------------------------------------------------------------- reading it */

export const forClient = platformQuery({
  args: { clientSlug: v.string() },
  handler: async (ctx, { clientSlug }) => {
    const client = await ctx.db
      .query("clients")
      .withIndex("by_slug", (q) => q.eq("slug", clientSlug.trim().toLowerCase()))
      .first();
    if (!client) return null;

    const rows = await ctx.db
      .query("subscriptions")
      .withIndex("by_client", (q) => q.eq("clientId", client._id))
      .collect();

    return {
      clientName: client.name,
      /** How this deployment is configured to charge, so a zero is legible. */
      mode: paystackMode(),
      subscriptions: rows.map(summarise),
    };
  },
});

export const all = platformQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("subscriptions").collect();
    const clients = new Map<string, Doc<"clients">>();
    for (const row of rows) {
      if (clients.has(row.clientId)) continue;
      const client = await ctx.db.get(row.clientId);
      if (client) clients.set(row.clientId, client);
    }
    return {
      mode: paystackMode(),
      subscriptions: rows.map((row) => ({
        ...summarise(row),
        clientName: clients.get(row.clientId)?.name ?? "(client removed)",
      })),
    };
  },
});

function summarise(row: Doc<"subscriptions">) {
  return {
    _id: row._id,
    plan: row.plan,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status,
    nextBillingAt: row.nextBillingAt ?? null,
    /*
     * Whether the PROVIDER knows about it. A pending row with no provider
     * reference is a checkout nobody completed, which reads identically to an
     * active subscription in a list that shows only a status.
     */
    liveAtProvider: Boolean(row.providerRef),
    suspendedAt: row.suspendedAt ?? null,
  };
}

/**
 * Cancel LOCALLY. It does not tell Paystack, and saying so is the point.
 *
 * Paystack needs a subscription code AND an email token to disable one, and
 * the token only arrives by asking their API for it. Doing half of it here —
 * marking ours cancelled while theirs keeps billing — would be the worst
 * available outcome: the client still pays, our screen says they do not, and
 * nobody looks again.
 *
 * So this refuses to pretend. It records the intent and tells you to do the
 * other half in the dashboard, which is thirty seconds and is honest.
 */
export const markCancelled = ownerMutation({
  args: { subscriptionId: v.id("subscriptions"), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.subscriptionId);
    if (!row) throw bad("NOT_FOUND", "No such subscription.");

    await patchDoc(ctx, args.subscriptionId, {
      status: "cancelled",
      lastEventAt: args.now ?? Date.now(),
    });

    return {
      cancelled: true,
      notice: row.providerRef
        ? `Cancel ${row.providerRef} in the Paystack dashboard too — this only changed our ` +
          "record, and Paystack will keep billing until it is disabled there."
        : "Nothing was live at Paystack, so there is nothing to cancel there.",
    };
  },
});

/** Read by the webhook path. Kept here so subscriptions.ts owns its own table. */
export const byReference = internalQuery({
  args: { startReference: v.string() },
  handler: (ctx, { startReference }) =>
    ctx.db
      .query("subscriptions")
      .withIndex("by_startReference", (q) => q.eq("startReference", startReference))
      .first(),
});
