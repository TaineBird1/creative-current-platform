import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * THE SEND CHOKE POINT.
 *
 * Every message in this system goes through `dispatch` below. Not "should" —
 * there is no other way to write the messages table, and guards.test.ts is
 * where that becomes enforceable. The reason is that the four rules a message
 * must obey are only safe if they are applied in ONE place:
 *
 *   1. never twice          — idempotency key, checked before insert
 *   2. never to demo/seed   — blocked here, not filtered at each caller
 *   3. never without consent — checked here against the consents table
 *   4. never at night       — held, not dropped, until the window opens
 *
 * Rule 2 is the one that most obviously belongs here rather than at each
 * caller. A reminder cron, a review request and a quote follow-up are three
 * separate paths; "remember to check isSeed" in three places is two places to
 * forget, and the failure is a real WhatsApp to a real phone number that
 * belongs to a business who never signed up.
 *
 * WHAT THIS DOES NOT DO: actually send anything. There is no provider driver
 * yet — no WhatsApp, no SMS. `dispatch` queues a row in the state a real
 * sender would pick up. That is deliberate and it is why nothing here claims
 * a message was delivered.
 */

/**
 * PREFER SENDING TWICE OVER SUPPRESSING.
 *
 * A duplicate is visible and mildly annoying. A suppression is invisible: the
 * customer is told nothing and arrives at the old time. Every judgement call
 * in this file resolves that way, which is why booking keys carry both
 * `startsAt` and `messageRevision` — two chances to differ rather than one.
 */
export type MessageKind =
  | { kind: "booking.confirmation"; bookingId: Id<"bookings">; startsAt: number; revision: number }
  | { kind: "booking.reminder24"; bookingId: Id<"bookings">; startsAt: number; revision: number }
  | { kind: "booking.reminder1"; bookingId: Id<"bookings">; startsAt: number; revision: number }
  | { kind: "booking.cancelled"; bookingId: Id<"bookings"> }
  | { kind: "quote.sent"; quoteId: Id<"quotes"> }
  | { kind: "quote.followup"; quoteId: Id<"quotes">; day: 2 | 5 | 10 }
  | { kind: "review.request"; bookingId: Id<"bookings"> }
  | { kind: "job.scheduled"; jobId: Id<"jobs">; scheduledFor: number };

/**
 * The idempotency key, derived in one place so no caller can invent its own.
 *
 * Booking keys carry startsAt AND messageRevision. startsAt alone would make
 * a 09:00 -> 10:00 -> 09:00 sequence reproduce its first key and suppress the
 * third message; the revision breaks that tie. guards.test.ts fails if
 * anything other than `book` writes startsAt without bumping it.
 */
export function idempotencyKeyFor(m: MessageKind): string {
  switch (m.kind) {
    case "booking.confirmation":
    case "booking.reminder24":
    case "booking.reminder1":
      return `${m.kind}:${m.bookingId}:${m.startsAt}:r${m.revision}`;
    case "booking.cancelled":
      // Terminal. A booking is cancelled once and telling someone twice that
      // it is off is noise, not safety.
      return `${m.kind}:${m.bookingId}`;
    case "quote.sent":
      // `quotes.send` only accepts a draft, so this happens once by construction.
      return `${m.kind}:${m.quoteId}`;
    case "quote.followup":
      return `${m.kind}:${m.quoteId}:d${m.day}`;
    case "review.request":
      // Once per completed visit, ever. A second request for one job is spam
      // whatever the interval.
      return `${m.kind}:${m.bookingId}`;
    case "job.scheduled":
      return `${m.kind}:${m.jobId}:${m.scheduledFor}`;
  }
}

/** 20:00–08:00 in the SITE's timezone. See `quietHoursTimezone`. */
const QUIET_FROM_HOUR = 20;
const QUIET_UNTIL_HOUR = 8;

/**
 * The local hour in a named timezone, without pulling in a date library.
 * Intl is present in the Convex runtime and is the only correct way to do
 * this — an offset arithmetic version is wrong twice a year.
 */
export function localHour(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(at));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "12");
}

/** Whether a moment falls inside quiet hours for a site's timezone. */
export function isQuiet(at: number, timeZone: string): boolean {
  const hour = localHour(at, timeZone);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/**
 * The next moment outside quiet hours. Held, never dropped: a reminder that
 * would land at 03:00 goes out at 08:00, because the alternative is a customer
 * who is never reminded at all.
 */
export function nextSendableAt(at: number, timeZone: string): number {
  let candidate = at;
  // Step in whole hours; at most a day of stepping, and it terminates.
  for (let i = 0; i < 26; i += 1) {
    if (!isQuiet(candidate, timeZone)) return candidate;
    candidate += 60 * 60 * 1000;
  }
  return candidate;
}

export type DispatchInput = {
  message: MessageKind;
  ventureId: Id<"ventures">;
  clientId: Id<"clients">;
  customerId: Id<"customers">;
  channel: "whatsapp" | "email" | "sms";
  templateKey: string;
  payload: Record<string, string>;
  /** The SITE's timezone. Not the recipient's — none exists. */
  quietHoursTimezone: string;
  now?: number;
};

export type DispatchResult =
  | { outcome: "queued"; messageId: Id<"messages">; scheduledFor: number; held: boolean }
  | { outcome: "duplicate"; messageId: Id<"messages"> }
  | { outcome: "suppressed_demo" }
  | { outcome: "suppressed_consent" };

/**
 * THE ONLY WAY A MESSAGE IS EVER CREATED.
 *
 * Returns an outcome rather than throwing for the suppression cases, because
 * they are ordinary and expected: a seeded client and a customer who opted
 * out are both correct states, not errors a caller should have to catch.
 */
export async function dispatch(ctx: MutationCtx, input: DispatchInput): Promise<DispatchResult> {
  const now = input.now ?? Date.now();
  const idempotencyKey = idempotencyKeyFor(input.message);

  /*
   * NEVER TWICE. Checked before anything else so a retry of a partially
   * failed caller cannot produce a second row. The read joins the
   * transaction's read set, so two concurrent dispatches of the same key
   * conflict and one retries rather than both inserting.
   */
  const existing = await ctx.db
    .query("messages")
    .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", idempotencyKey))
    .unique();
  if (existing) return { outcome: "duplicate", messageId: existing._id };

  const client = await ctx.db.get(input.clientId);
  const customer = await ctx.db.get(input.customerId);
  if (!client || !customer) {
    throw new ConvexError({ code: "NOT_FOUND", message: "No such client or customer." });
  }

  /*
   * NEVER TO DEMO OR SEED. Here, once, rather than at each caller.
   *
   * A row is still written, with the suppressed status — an invisible drop is
   * indistinguishable from a bug, and the whole point of this table is being
   * able to answer "why did nobody hear from us".
   */
  const isDemo = client.isDemo || customer.isDemo;
  const isSeed = client.isSeed || customer.isSeed;
  if (isDemo || isSeed) {
    await ctx.db.insert("messages", {
      ventureId: input.ventureId,
      clientId: input.clientId,
      customerId: input.customerId,
      channel: input.channel,
      to: customer.phone,
      templateKey: input.templateKey,
      payload: input.payload,
      idempotencyKey,
      status: "suppressed_demo",
      quietHoursTimezone: input.quietHoursTimezone,
      scheduledFor: now,
      attempts: 0,
      isDemo,
      isSeed,
    });
    return { outcome: "suppressed_demo" };
  }

  /*
   * NEVER WITHOUT CONSENT. The newest row for the channel decides, and ABSENT
   * IS NOT GRANTED — a customer who has never been asked has not agreed.
   *
   * READ THIS BEFORE CALLING THIS COMPLIANT: nothing can set "withdrawn" from
   * an inbound STOP, because there is no provider webhook and no inbound
   * pipeline at all. The only way a withdrawal reaches this table today is a
   * staff member recording one by hand. The check below is real and it works;
   * the half that makes STOP honoured automatically does not exist yet.
   */
  const consents = await ctx.db
    .query("consents")
    .withIndex("by_customer_channel", (q) =>
      q.eq("customerId", input.customerId).eq("channel", input.channel),
    )
    .collect();
  const latest = consents.sort((a, b) => b.at - a.at)[0];
  if (!latest || latest.state !== "granted") {
    await ctx.db.insert("messages", {
      ventureId: input.ventureId,
      clientId: input.clientId,
      customerId: input.customerId,
      channel: input.channel,
      to: customer.phone,
      templateKey: input.templateKey,
      payload: input.payload,
      idempotencyKey,
      status: "suppressed_consent",
      quietHoursTimezone: input.quietHoursTimezone,
      scheduledFor: now,
      attempts: 0,
      isDemo,
      isSeed,
    });
    return { outcome: "suppressed_consent" };
  }

  /*
   * NEVER AT NIGHT — held, not dropped. A reminder that would land at 03:00
   * goes out at 08:00; dropping it would mean the customer is never reminded,
   * which is the failure this whole module exists to avoid.
   */
  const held = isQuiet(now, input.quietHoursTimezone);
  const scheduledFor = held ? nextSendableAt(now, input.quietHoursTimezone) : now;

  const messageId = await ctx.db.insert("messages", {
    ventureId: input.ventureId,
    clientId: input.clientId,
    customerId: input.customerId,
    channel: input.channel,
    to: customer.phone,
    templateKey: input.templateKey,
    payload: input.payload,
    idempotencyKey,
    status: held ? "holding_quiet_hours" : "scheduled",
    quietHoursTimezone: input.quietHoursTimezone,
    scheduledFor,
    attempts: 0,
    isDemo,
    isSeed,
  });

  return { outcome: "queued", messageId, scheduledFor, held };
}
