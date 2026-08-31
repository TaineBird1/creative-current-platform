import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * PROVIDER WEBHOOKS.
 *
 * This is the messaging idempotency problem with money attached, and it is
 * worse in three ways: the sender retries on its own schedule, the events
 * arrive in whatever order the network gives them, and the same event WILL
 * be delivered twice. None of those are edge cases — Paystack and Paddle
 * both document all three as normal behaviour.
 *
 * THE EVENT ID IS THE PROVIDER'S, NEVER OURS. A key we derive from the
 * payload's contents cannot tell a retry apart from a genuine second charge
 * of the same amount to the same customer a minute later. The provider is
 * the only party that knows which of those it sent.
 *
 * ORDERING IS NOT ASSUMED ANYWHERE. `occurredAt` is the provider's own
 * timestamp for when the thing happened, and it is the only field the code
 * compares. `receivedAt` is ours and is deliberately never used to decide
 * anything: it records when the packet reached us, which for a retried event
 * is minutes or hours after the fact it describes.
 */
export const webhookTables = {
  webhookEvents: defineTable({
    provider: v.union(v.literal("paystack"), v.literal("paddle")),
    /** The PROVIDER's id for this event. Idempotency hangs off this alone. */
    eventId: v.string(),
    type: v.string(),
    /** The provider's timestamp: when the thing HAPPENED. Ordering uses this. */
    occurredAt: v.number(),
    /** Ours: when the packet arrived. Never used to order anything. */
    receivedAt: v.number(),
    status: v.union(
      /** Handled; any facts or state changes it implied are recorded. */
      v.literal("applied"),
      /** Seen before. No side effects, second time or fiftieth. */
      v.literal("duplicate"),
      /**
       * Real, verified, and we cannot tell whose it is. Parked, never
       * guessed at — crediting the wrong client is not recoverable, and a
       * row sitting here waiting for a human is.
       */
      v.literal("unattributed"),
      /** A type this codebase does not act on. Recorded so it is not a mystery. */
      v.literal("ignored"),
      /**
       * Verified and attributed, and a ledger rule said no — a demo client
       * being charged real money, an amount that is not whole cents. The
       * money is refused and the event is KEPT, because the alternative is a
       * mutation that aborts, records nothing, and leaves the anomaly
       * visible only in the provider's failed-delivery dashboard.
       */
      v.literal("refused"),
      /**
       * Arrived after a NEWER event already decided the same state. The fact
       * is kept; the stale transition is not applied.
       */
      v.literal("superseded"),
    ),
    /** Why it landed in that status, in words a human can act on. */
    note: v.optional(v.string()),
    clientId: v.optional(v.id("clients")),
    subscriptionId: v.optional(v.id("subscriptions")),
    paymentId: v.optional(v.id("payments")),
  })
    .index("by_provider_event", ["provider", "eventId"])
    .index("by_status", ["status", "receivedAt"]),
};
