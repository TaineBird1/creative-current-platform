import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { postEntry } from "./lib/ledger";
import { assertCents, type Currency } from "./lib/money";

/**
 * WHAT A VERIFIED WEBHOOK DOES TO OUR DATA.
 *
 * The signature check has already happened in http.ts — nothing here runs on
 * unverified bytes. What is left is the hard part, which is that these events
 * arrive twice and out of order, and both failures are silent.
 *
 * THE DESIGN: FACTS ARE APPENDED, STATE IS ADVANCED.
 *
 * The two need opposite handling, and treating them alike is what makes
 * out-of-order delivery break things.
 *
 *   A FACT is "R500 arrived at 14:02". It is append-only, it is true whenever
 *   we hear about it, and order genuinely does not matter — a balance is a
 *   sum, and addition does not care what sequence the rows were written in.
 *   So a payment is recorded no matter how late it turns up.
 *
 *   A STATE is "this subscription is cancelled". Here order is the whole
 *   question, and it is decided by the PROVIDER's timestamp, never by arrival:
 *   an event older than the one that last set the state does not get to
 *   overwrite it. It is still recorded, marked `superseded`.
 *
 * That is precisely the case worth naming: `charge.success` arriving after
 * `subscription.disable`. The money is real and gets recorded — it did
 * arrive. The subscription stays cancelled, because the cancellation is
 * newer. Handling them as one ordered stream would either lose the payment or
 * resurrect the subscription, and both look fine until someone reconciles.
 *
 * WHAT WE CANNOT ATTRIBUTE, WE PARK.
 *
 * An event we cannot tie to a client is written with status `unattributed`
 * and no money moves. Guessing is not available: crediting the wrong client
 * is not recoverable, and a row waiting for a human is.
 */

const provider = v.union(v.literal("paystack"), v.literal("paddle"));

/** Types this codebase acts on. Anything else is recorded and ignored. */
const HANDLED = new Set([
  "charge.success",
  "transaction.completed",
  "subscription.create",
  "subscription.disable",
  "subscription.not_renew",
  "subscription.canceled",
  "invoice.payment_failed",
]);

/**
 * Where each event drives the subscription's status. `null` means the event
 * says nothing about status — a payment does not activate a subscription, and
 * a failed charge does NOT suspend one (see the schema: suspension is
 * explicit-only, because a card declining once is not a decision to cancel).
 */
const STATUS_FROM_EVENT: Record<string, Doc<"subscriptions">["status"] | null> = {
  "charge.success": null,
  "transaction.completed": null,
  "subscription.create": "active",
  "subscription.disable": "cancelled",
  "subscription.not_renew": "cancelled",
  "subscription.canceled": "cancelled",
  "invoice.payment_failed": "past_due",
};

export const ingest = internalMutation({
  args: {
    provider,
    eventId: v.string(),
    type: v.string(),
    /** The provider's timestamp. Null when it sent none — see below. */
    occurredAt: v.union(v.number(), v.null()),
    receivedAt: v.number(),
    /** Already parsed, already verified. */
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    /*
     * IDEMPOTENCY, FIRST AND UNCONDITIONALLY.
     *
     * Before attribution, before money, before anything. Convex mutations are
     * serializable, so this read joins the transaction's read set and two
     * concurrent deliveries of the same event cannot both pass it — one
     * retries and finds the row.
     */
    const seen = await ctx.db
      .query("webhookEvents")
      .withIndex("by_provider_event", (q) =>
        q.eq("provider", args.provider).eq("eventId", args.eventId),
      )
      .unique();

    if (seen) {
      return { status: "duplicate" as const, eventId: args.eventId };
    }

    /*
     * An event with no provider timestamp cannot be ordered against anything.
     * It is NOT stamped with `now`: a three-hour-old retry stamped now would
     * look like the newest thing we know and would overwrite a newer state.
     * It records its facts and declines to touch state.
     */
    const occurredAt = args.occurredAt;

    const record = async (
      status: Doc<"webhookEvents">["status"],
      extra: {
        note?: string;
        clientId?: Id<"clients">;
        subscriptionId?: Id<"subscriptions">;
        paymentId?: Id<"payments">;
      } = {},
    ) => {
      await ctx.db.insert("webhookEvents", {
        provider: args.provider,
        eventId: args.eventId,
        type: args.type,
        occurredAt: occurredAt ?? args.receivedAt,
        receivedAt: args.receivedAt,
        status,
        ...extra,
      });
      return { status, eventId: args.eventId };
    };

    if (!HANDLED.has(args.type)) {
      // Recorded rather than dropped: an event nobody can find later is
      // indistinguishable from an endpoint that was never called.
      return record("ignored", { note: `no handler for ${args.type}` });
    }

    const payload = (args.payload ?? {}) as Record<string, unknown>;
    const data = (payload.data ?? {}) as Record<string, unknown>;

    // --- attribution -------------------------------------------------------
    const subscriptionRef = refFrom(data, ["subscription_code", "subscription_id", "id"]);
    const subscription = subscriptionRef
      ? await ctx.db
          .query("subscriptions")
          .filter((q) => q.eq(q.field("providerRef"), subscriptionRef))
          .first()
      : null;

    if (!subscription) {
      /*
       * This is the ordinary out-of-order case, not an error: a
       * `charge.success` can beat the `subscription.create` that would have
       * told us whose it is. Parked with the payload intact so it can be
       * reconciled — by a human today, and by a replay path later.
       */
      return record("unattributed", {
        note: subscriptionRef
          ? `no subscription with providerRef ${subscriptionRef}`
          : "no subscription reference in the payload",
      });
    }

    const client = await ctx.db.get(subscription.clientId);
    if (!client) {
      return record("unattributed", { note: "subscription points at a missing client" });
    }

    // --- the FACT: money that moved ---------------------------------------
    let paymentId: Id<"payments"> | undefined;
    const amountCents = amountFrom(data);

    if ((args.type === "charge.success" || args.type === "transaction.completed") && amountCents) {
      const currency = (currencyFrom(data) ?? subscription.currency) as Currency;

      /*
       * A LEDGER REFUSAL IS AN OUTCOME, NOT A CRASH.
       *
       * postEntry applies every ledger rule — whole cents, the sign matching
       * the type, the client belonging to the venture, demo and seed data
       * never accruing. A webhook is exactly the caller those rules were
       * written for: the amount arrives already decided by somebody else.
       *
       * But letting the refusal escape would abort the whole mutation, and
       * the mutation is what records the event. The provider would then
       * retry the same doomed event for hours and give up, leaving the
       * anomaly — a demo client being charged real money — visible only in
       * Paystack's failed-delivery dashboard, which nobody reads.
       *
       * So a REFUSAL is caught and parked: no money moves, the event is kept
       * with the reason, and someone can see it. An unexpected error is NOT
       * caught — that is a bug in this file, and a 500 that makes the
       * provider retry is the right answer while it is being fixed. The
       * difference between the two is the whole point of the narrow catch.
       */
      try {
        /*
         * THE LEDGER GOES FIRST, and the order is load-bearing.
         *
         * postEntry is the thing that can refuse. Writing the payments row
         * before it means a refusal we catch leaves an orphan behind — a row
         * in `payments` saying money arrived, with nothing in the ledger
         * agreeing, which is precisely the disagreement between two money
         * tables that nobody notices until reconciliation.
         */
        await postEntry(ctx, {
          ventureId: subscription.ventureId,
          clientId: subscription.clientId,
          type: "payment_received",
          amountCents,
          currency,
          occurredAt: occurredAt ?? args.receivedAt,
          description: `${args.provider} ${args.type} — ${subscription.plan}`,
        });

        paymentId = await ctx.db.insert("payments", {
          ventureId: subscription.ventureId,
          clientId: subscription.clientId,
          amountCents,
          currency,
          provider: args.provider,
          providerRef: refFrom(data, ["reference", "transaction_id", "id"]) ?? args.eventId,
          status: "succeeded",
          /*
           * When the money moved, per the provider. Using arrival time here
           * would put a retried payment in the wrong month, and a month that
           * has been reported on is supposed to stay closed.
           */
          receivedAt: occurredAt ?? args.receivedAt,
          webhookEventId: args.eventId,
        });
      } catch (error) {
        const refusal = refusalCode(error);
        if (!refusal) throw error;
        return record("refused", {
          clientId: client._id,
          subscriptionId: subscription._id,
          note: `ledger refused this payment: ${refusal}`,
        });
      }
    }

    // --- the STATE: only if this event is newer than what set it -----------
    const wants = STATUS_FROM_EVENT[args.type] ?? null;

    if (wants === null) {
      return record("applied", {
        clientId: client._id,
        subscriptionId: subscription._id,
        paymentId,
        note: paymentId ? undefined : "no money and no status change in this event",
      });
    }

    if (occurredAt === null) {
      return record("superseded", {
        clientId: client._id,
        subscriptionId: subscription._id,
        paymentId,
        note: "no provider timestamp, so it cannot be ordered — status left alone",
      });
    }

    const lastEventAt = subscription.lastEventAt ?? 0;
    if (occurredAt < lastEventAt) {
      /*
       * THE CASE THIS WHOLE FILE EXISTS FOR. A newer event already decided
       * this status. Applying this one would silently roll the subscription
       * back to a state the customer has already moved on from.
       */
      return record("superseded", {
        clientId: client._id,
        subscriptionId: subscription._id,
        paymentId,
        note: `older than the event at ${lastEventAt}; status left as ${subscription.status}`,
      });
    }

    await ctx.db.patch(subscription._id, { status: wants, lastEventAt: occurredAt });

    return record("applied", {
      clientId: client._id,
      subscriptionId: subscription._id,
      paymentId,
      note: `status ${subscription.status} -> ${wants}`,
    });
  },
});

function refFrom(data: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

/**
 * Both providers send minor units already — Paystack `amount` in kobo/cents,
 * Paddle in the smallest unit as a string. No division happens here and none
 * should: a `/ 100` anywhere in this path is how a rand becomes a cent.
 */
function amountFrom(data: Record<string, unknown>): number | null {
  const raw = data.amount ?? (data.details as Record<string, unknown> | undefined)?.totals;
  const value =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).total
      : raw;
  if (typeof value === "number") return assertCents(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return assertCents(Number(value));
  return null;
}

function currencyFrom(data: Record<string, unknown>): string | null {
  const raw = data.currency ?? data.currency_code;
  return typeof raw === "string" ? raw.toUpperCase() : null;
}

/**
 * A deliberate refusal from the ledger, or something unexpected?
 *
 * Only these codes are decisions the ledger is entitled to make about a
 * payment. Anything else — a missing table, a bad Id, a typo in this file —
 * is a bug, and swallowing it would turn a broken handler into one that
 * quietly answers 200 while dropping real money on the floor.
 */
const LEDGER_REFUSALS = new Set([
  "NOT_A_REAL_CLIENT",
  "CLIENT_VENTURE_MISMATCH",
  "BAD_MONEY",
  "WRONG_SIGN",
  "ZERO_ENTRY",
  "INVALID",
]);

function refusalCode(error: unknown): string | null {
  const data = (error as { data?: unknown })?.data;
  const code = (data as { code?: unknown })?.code;
  return typeof code === "string" && LEDGER_REFUSALS.has(code) ? code : null;
}
