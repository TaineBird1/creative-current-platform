import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  CLAIMABLE,
  claimForSend,
  recordSendResult,
  requeueStalled,
  type ClaimedMessage,
} from "./lib/messaging";
import { driverFor, renderMessage, type SendResult } from "./lib/providers";
import { queueBookingReminderFor } from "./messages";

/**
 * THE DRAIN — what turns a queued row into a message somebody receives.
 *
 * `dispatch` writes rows and stops. This is the other end: a cron picks up
 * whatever is due, hands each to its provider, and writes down what happened.
 *
 * THREE MUTATIONS, NOT ONE, and the split is the whole design. A provider call
 * is network I/O, so it has to happen in an action; an action has no
 * transaction. So: CLAIM in a mutation (serializable, so exactly one drain
 * gets a given row), SEND in the action, RECORD in a second mutation. The gap
 * between claim and record is the only place this can go wrong, and
 * `requeueStalled` is the answer to it — a row stuck mid-send goes back in the
 * queue rather than being abandoned, which risks a duplicate and rules out
 * silence. That is this codebase's stated preference, applied here.
 *
 * NOTHING IN THIS FILE DECIDES WHETHER A MESSAGE MAY BE SENT. Consent, demo
 * suppression, the do-not-call list and quiet hours are all settled before a
 * row exists, in lib/messaging.ts. The drain reads rows that already passed
 * them. The one exception is quiet hours, re-checked at claim time because a
 * row can be written at 19:58 and reached at 20:01.
 */

/** How many rows one drain pass handles. See the log line where it is hit. */
const DRAIN_BATCH = 25;

const sendResult = v.union(
  v.object({
    delivered: v.literal(true),
    providerName: v.string(),
    providerMessageId: v.optional(v.string()),
  }),
  v.object({
    delivered: v.literal(false),
    providerName: v.string(),
    retryable: v.boolean(),
    error: v.string(),
  }),
);

/**
 * Everything due. Two index reads because a held row and a scheduled one are
 * both due once their moment arrives, and `by_status_scheduledFor` is keyed on
 * status first.
 */
export const due = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { now, limit }): Promise<Id<"messages">[]> => {
    const found: Id<"messages">[] = [];
    for (const status of CLAIMABLE) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_status_scheduledFor", (q) =>
          q.eq("status", status).lte("scheduledFor", now),
        )
        .take(limit ?? DRAIN_BATCH);
      found.push(...rows.map((row) => row._id));
    }
    return found.slice(0, limit ?? DRAIN_BATCH);
  },
});

/**
 * Rows claimed by a drain that never came back. `scheduledFor` on a `sending`
 * row is its reclaim deadline — see SENDING_TIMEOUT_MS — so this is the same
 * index read as everything else.
 */
export const stalled = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { now, limit }): Promise<Id<"messages">[]> => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_status_scheduledFor", (q) =>
        q.eq("status", "sending").lte("scheduledFor", now),
      )
      .take(limit ?? DRAIN_BATCH);
    return rows.map((row) => row._id);
  },
});

export const claim = internalMutation({
  args: { messageId: v.id("messages"), now: v.number() },
  handler: (ctx, args): Promise<ClaimedMessage | null> => claimForSend(ctx, args),
});

export const record = internalMutation({
  args: { messageId: v.id("messages"), result: sendResult, now: v.number() },
  handler: (ctx, args): Promise<void> => recordSendResult(ctx, args),
});

export const requeue = internalMutation({
  args: { messageId: v.id("messages"), now: v.number() },
  handler: (ctx, args): Promise<boolean> => requeueStalled(ctx, args),
});

/**
 * The cron entry point.
 *
 * Sequential rather than parallel on purpose. The batch is small, providers
 * rate-limit, and a failure that takes out one message should not be racing
 * twenty-four others while it does it. If throughput ever matters this is the
 * obvious place to widen — but it will need a rate limiter at the same time,
 * not instead.
 */
export const drain = internalAction({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ attempted: number; delivered: number }> => {
    const now = args.now ?? Date.now();

    // Stranded rows first, so a row that has already waited goes back in the
    // queue before this pass reads what is due.
    const stuck: Id<"messages">[] = await ctx.runQuery(internal.outbox.stalled, { now });
    for (const messageId of stuck) {
      const requeued: boolean = await ctx.runMutation(internal.outbox.requeue, {
        messageId,
        now,
      });
      if (requeued) {
        console.warn(`[outbox] requeued a stalled send: ${messageId}`);
      }
    }

    const ids: Id<"messages">[] = await ctx.runQuery(internal.outbox.due, {
      now,
      limit: args.limit ?? DRAIN_BATCH,
    });
    if (ids.length >= (args.limit ?? DRAIN_BATCH)) {
      // Not silent: a full batch means there is more behind it, and the next
      // run picks it up. Said out loud so a backlog is visible as a backlog
      // rather than as messages that seem slow for no reason.
      console.warn(`[outbox] batch full at ${ids.length}; more messages are waiting`);
    }

    let delivered = 0;
    for (const messageId of ids) {
      const claimed: ClaimedMessage | null = await ctx.runMutation(internal.outbox.claim, {
        messageId,
        now,
      });
      // Null means somebody else took it, it resolved, or it went back to
      // holding. All three mean: not ours, move on.
      if (!claimed) continue;

      const result = await send(claimed);
      if (result.delivered) delivered += 1;

      await ctx.runMutation(internal.outbox.record, { messageId, result, now });
    }

    return { attempted: ids.length, delivered };
  },
});

/**
 * Render, then hand to the driver. Separated so the failure modes are visible:
 * a template that does not exist and a provider that refuses are different
 * problems and get different sentences in the outbox.
 */
async function send(claimed: ClaimedMessage): Promise<SendResult> {
  const content = renderMessage({
    templateKey: claimed.templateKey,
    channel: claimed.channel,
    payload: claimed.payload,
    clientName: claimed.clientName,
    timezone: claimed.timezone,
  });

  if (!content) {
    // Retrying renders the same nothing. This is a bug in whatever queued it.
    return {
      delivered: false,
      providerName: "none",
      retryable: false,
      error: `No ${claimed.channel} template for "${claimed.templateKey}".`,
    };
  }

  const driver = driverFor(claimed.channel);
  try {
    return await driver.send({
      channel: claimed.channel,
      to: claimed.to,
      templateKey: claimed.templateKey,
      subject: content.subject,
      body: content.body,
      clientName: claimed.clientName,
    });
  } catch (error) {
    /*
     * A driver is not supposed to throw — the contract is a returned verdict —
     * but an unhandled throw here would leave the row in `sending` until the
     * stall sweep found it, which is ten minutes of a message looking like it
     * is in flight when nothing is holding it. Caught and turned into the
     * verdict the driver should have returned.
     */
    return {
      delivered: false,
      providerName: driver.name,
      retryable: true,
      error: `The ${driver.name} driver threw: ${String(error)}`,
    };
  }
}

/* ------------------------------------------------------------- reminders */

/**
 * REMINDERS ARE SWEPT, NOT SCHEDULED AT BOOKING TIME.
 *
 * The tempting version is `scheduler.runAt(startsAt - 24h, ...)` when the
 * booking is made. It is wrong for one reason that matters: a scheduled job
 * fires at the time it was created for, and a booking that MOVES does not move
 * it. A Friday booking pushed to Monday would get its "tomorrow" reminder on
 * Thursday, correctly describing Monday. Cancellations have the same shape —
 * the job still exists and the booking does not.
 *
 * A sweep reads current state every time, so a moved booking is simply found
 * at its new time and a cancelled one is not found at all. It costs one
 * indexed range read per run, which is the cheapest thing in this file.
 *
 * Overlapping windows are deliberate and free: the idempotency key carries
 * `startsAt` and `messageRevision`, so seeing the same booking twice produces
 * a duplicate that dispatch refuses. That is what lets the window be wider
 * than the cron interval, which is what makes a missed run recoverable instead
 * of a reminder nobody ever gets.
 */
const REMINDER_LOOKBACK_MS = 60 * 60 * 1000;
const REMINDER_BATCH = 200;

/** A cancelled or no-show booking is not reminded about. */
const REMINDABLE = ["pending", "confirmed", "in_progress"];

export const queueDueReminders = internalMutation({
  args: {
    hoursBefore: v.union(v.literal(24), v.literal(1)),
    /** The cron interval. The window is this wide, plus the lookback. */
    windowMs: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ queued: number; considered: number }> => {
    const now = args.now ?? Date.now();
    const mark = now + args.hoursBefore * 60 * 60 * 1000;

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_start", (q) =>
        q.gte("startsAt", mark - REMINDER_LOOKBACK_MS).lt("startsAt", mark + args.windowMs),
      )
      .take(REMINDER_BATCH);

    if (bookings.length === REMINDER_BATCH) {
      console.warn(
        `[outbox] reminder sweep hit its ${REMINDER_BATCH} cap; some bookings in this ` +
          "window were not considered. Widen the cap or shorten the interval.",
      );
    }

    let queued = 0;
    for (const booking of bookings) {
      if (!REMINDABLE.includes(booking.status)) continue;
      const result = await queueBookingReminderFor(ctx, {
        bookingId: booking._id,
        hoursBefore: args.hoursBefore,
        now,
      });
      if (result.outcome === "queued") queued += 1;
    }

    return { queued, considered: bookings.length };
  },
});
