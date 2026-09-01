import { ConvexError } from "convex/values";
import { contactDecision } from "./suppression";
import { recipientIsLead } from "./leadAccess";
import type { SendResult } from "./providers";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { hasConsent } from "./consent";

/**
 * THE SEND CHOKE POINT.
 *
 * Every message in this system goes through `dispatch` below. Not "should" —
 * there is no other way to write the messages table, and guards.test.ts is
 * where that becomes enforceable. The reason is that the five rules a message
 * must obey are only safe if they are applied in ONE place:
 *
 *   1. never twice          — idempotency key, checked before insert
 *   2. never to demo/seed   — blocked here, not filtered at each caller
 *   3. never to a LEAD      — a prospect is not a customer; see leadAccess
 *   4. never without consent — checked here against the consents table
 *   5. never at night       — held, not dropped, until the window opens
 *
 * Rule 2 is the one that most obviously belongs here rather than at each
 * caller. A reminder cron, a review request and a quote follow-up are three
 * separate paths; "remember to check isSeed" in three places is two places to
 * forget, and the failure is a real WhatsApp to a real phone number that
 * belongs to a business who never signed up.
 *
 * Rule 3 is rule 2's blind spot, and it was found by asking what the demo
 * flags actually mean. They are DESIGNATIONS applied to data we invented. A
 * lead carries neither and is not covered by either, because a lead is real —
 * the dev deployment holds 39 actual solar installers with actual numbers —
 * and that is exactly what makes messaging one the expensive mistake rather
 * than the harmless one.
 *
 * WHAT THIS DOES NOT DO: talk to a provider. `dispatch` queues a row and
 * stops; the drain in outbox.ts picks it up, and lib/providers.ts is what
 * knows how to send. The send-side writes are at the bottom of THIS file
 * anyway, because claiming a message was sent has the same property as
 * creating one — it is only checkable if one file can do it.
 *
 * EMAIL SENDS FOR REAL, over Resend. WhatsApp and SMS do not: they have a
 * no-op driver that logs the message and records a refusal with the reason.
 * Nothing here or below pretends otherwise, which is the point.
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
  | { outcome: "suppressed_consent" }
  | { outcome: "suppressed_lead"; reason: string }
  | { outcome: "no_destination"; messageId: Id<"messages"> };

/**
 * WHERE A CHANNEL ACTUALLY SENDS TO.
 *
 * `to` used to be the phone number whatever the channel was, which is correct
 * for WhatsApp and SMS and quietly wrong for email — it would hand a driver a
 * phone number and ask it to send mail to it. Nothing caught that because no
 * driver existed to try.
 *
 * Null means the customer has nothing on this channel. That is a REFUSAL, not
 * a fallback to another channel: silently emailing someone who was promised a
 * WhatsApp (or the reverse) is a decision the caller made and this function is
 * not the place to overturn it.
 */
export function destinationFor(
  customer: { phone: string; email?: string },
  channel: "whatsapp" | "email" | "sms",
): string | null {
  if (channel === "email") return customer.email?.trim() || null;
  return customer.phone.trim() || null;
}

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

  // Null here does not stop the suppression rows below from being written —
  // they record WHY nobody was contacted, and "we had nowhere to send it" is
  // the least useful of the available answers, so it is checked last.
  const destination = destinationFor(customer, input.channel);

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
      to: destination ?? customer.phone,
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
   * NEVER A LEAD.
   *
   * The demo/seed block above catches data we MADE UP. This catches data that
   * is entirely real and still must never be messaged: a business we are
   * prospecting. `isDemo` and `isSeed` are designations, and no honest one
   * exists for a lead — a lead is a real company with a real number, which is
   * why the mistake is expensive rather than embarrassing.
   *
   * Outreach in this business is drafted and sent by hand, on purpose. A
   * transactional pipeline that can reach a prospect is an outreach channel
   * whether or not anyone meant to build one, and it is one that sends on a
   * cron.
   *
   * Checked HERE, at queue time, rather than at the driver: a queued row is
   * already a decision, and a person reading the outbox should see the
   * refusal rather than a message waiting its turn.
   *
   * `recipientIsLead` fails closed — see lib/leadAccess.ts — so an error or
   * an address it cannot canonicalise both refuse.
   */
  /*
   * The CUSTOMER's own identifiers, both of them, whichever address this
   * particular message happens to use. A customer record carrying a lead's
   * phone number IS that lead, and emailing them instead does not make it
   * somebody else.
   */
  const leadCheck = await recipientIsLead(ctx, {
    phone: customer.phone,
    email: customer.email ?? null,
  });
  if (leadCheck.verdict !== "clear") {
    await ctx.db.insert("messages", {
      ventureId: input.ventureId,
      clientId: input.clientId,
      customerId: input.customerId,
      channel: input.channel,
      to: destination ?? customer.phone,
      templateKey: input.templateKey,
      payload: input.payload,
      idempotencyKey,
      status: "suppressed_lead",
      error: leadCheck.reason,
      quietHoursTimezone: input.quietHoursTimezone,
      scheduledFor: now,
      attempts: 0,
      isDemo,
      isSeed,
    });
    return { outcome: "suppressed_lead", reason: leadCheck.reason };
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
  // Same tie-break as customers.consentState, from one helper so the two can
  // never disagree about whether someone consented.
  if (!hasConsent(consents)) {
    await ctx.db.insert("messages", {
      ventureId: input.ventureId,
      clientId: input.clientId,
      customerId: input.customerId,
      channel: input.channel,
      to: destination ?? customer.phone,
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
   * NEVER SOMEBODY WHO ASKED US TO STOP, wherever they asked.
   *
   * The suppression list is written against LEADS, and this is a message to a
   * CUSTOMER — so at first glance it does not apply. It does, and that gap is
   * exactly the one worth closing: a business that told us to leave them
   * alone during prospecting, and later appears here because somebody typed
   * their number into a booking, has not changed their mind. Matching on the
   * phone means one refusal covers both populations.
   *
   * `contactDecision` fails CLOSED — an error or an ambiguity comes back
   * blocked — so a lookup that goes wrong holds the message instead of
   * sending it. See lib/suppression.ts for why that direction is the
   * recoverable one.
   */
  const verdict = await contactDecision(ctx, { phone: customer.phone });
  if (verdict.blocked) {
    await ctx.db.insert("messages", {
      ventureId: input.ventureId,
      clientId: input.clientId,
      customerId: input.customerId,
      channel: input.channel,
      to: destination ?? customer.phone,
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
   * NOWHERE TO SEND IT. Terminal, and recorded as a row like every other
   * refusal in this function.
   *
   * `failed` rather than a status of its own, because the outbox reads it as
   * "this did not go, and here is the sentence saying why" either way, and a
   * status nothing else in the system distinguishes is a schema column earning
   * nothing. attempts stays 0: no provider was asked, so claiming an attempt
   * would misreport what happened.
   */
  if (!destination) {
    const messageId = await ctx.db.insert("messages", {
      ventureId: input.ventureId,
      clientId: input.clientId,
      customerId: input.customerId,
      channel: input.channel,
      to: "",
      templateKey: input.templateKey,
      payload: input.payload,
      idempotencyKey,
      status: "failed",
      error:
        input.channel === "email"
          ? "No email address on file for this customer, so there was nowhere to send it."
          : `No ${input.channel} number on file for this customer.`,
      quietHoursTimezone: input.quietHoursTimezone,
      scheduledFor: now,
      attempts: 0,
      isDemo,
      isSeed,
    });
    return { outcome: "no_destination", messageId };
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
    to: destination,
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

/* ==========================================================================
 * THE SEND SIDE.
 *
 * Everything above decides whether a row may exist. Everything below moves an
 * existing row towards sent or failed, and it lives in this file for the same
 * reason dispatch does: these are the only writes that can claim a customer
 * was contacted, and one file is the only way "only one thing may claim that"
 * is checkable. guards.test.ts fails on a `sending`/`sent`/`failed` status
 * written anywhere else.
 * ======================================================================= */

/**
 * How long a claimed row may sit in `sending` before another drain takes it.
 *
 * The drain claims a row in one mutation, calls a provider from an action, and
 * records the verdict in a second mutation. If the action dies in between —
 * deploy, timeout, provider hanging — the row is stranded in `sending` and
 * nothing else will ever look at it.
 *
 * PREFER SENDING TWICE OVER SUPPRESSING settles what to do: after this long,
 * the row goes back in the queue. That risks a duplicate in the case where the
 * provider did accept it and only the recording failed. A duplicate
 * confirmation is mildly annoying; a customer who is never told is the failure
 * the whole module exists to avoid. Ten minutes is long enough that a slow
 * provider is not mistaken for a dead one.
 */
export const SENDING_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tries before a retryable failure becomes a permanent one.
 *
 * Not unlimited. A row retrying forever is indistinguishable, from the outbox,
 * from one still waiting its turn — so the thing a person needs to see (this
 * is not going to happen, look at it) never surfaces.
 */
export const MAX_ATTEMPTS = 5;

/** Roughly a minute, five, half an hour, two hours, then give up. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

const backoffFor = (attempts: number) =>
  BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;

/** The statuses a drain is allowed to pick up. */
export const CLAIMABLE = ["scheduled", "holding_quiet_hours"] as const;

/** Everything a driver needs, read once, inside the claiming transaction. */
export type ClaimedMessage = {
  messageId: Id<"messages">;
  channel: "whatsapp" | "email" | "sms";
  to: string;
  templateKey: string;
  payload: Record<string, string>;
  clientName: string;
  timezone: string;
  attempts: number;
  /**
   * The client own contact address, or null. Resolved into an actual reply-to
   * by `resolveReplyTo` at send time, which also applies the deployment
   * fallback — one resolution, shared by the renderer and the driver, so the
   * copy cannot invite a reply the envelope will not deliver.
   */
  clientContactEmail: string | null;
};

/**
 * Take a message out of the queue, exactly once.
 *
 * Convex mutations are serializable, so the read of `status` and the write of
 * `sending` are one transaction: two drains running against the same row
 * conflict, one commits, and the other re-reads and finds it already claimed.
 * That is what makes "exactly once" true here without a lock.
 *
 * Returns null for every reason not to send, and the caller treats them all
 * the same way — skip it. Distinguishing them would only give a caller the
 * chance to disagree.
 */
export async function claimForSend(
  ctx: MutationCtx,
  args: { messageId: Id<"messages">; now: number },
): Promise<ClaimedMessage | null> {
  const message = await ctx.db.get(args.messageId);
  if (!message) return null;

  // Somebody else got there first, or it has already resolved.
  if (!(CLAIMABLE as readonly string[]).includes(message.status)) return null;
  if (message.scheduledFor > args.now) return null;

  /*
   * Quiet hours are re-checked HERE and not only at dispatch. A row queued at
   * 19:58 is not quiet when it is written and is quiet three minutes later
   * when the drain reaches it, and the customer whose phone lights up at
   * 20:01 does not care which side of the boundary the write happened on.
   */
  if (isQuiet(args.now, message.quietHoursTimezone)) {
    await ctx.db.patch(args.messageId, {
      status: "holding_quiet_hours",
      scheduledFor: nextSendableAt(args.now, message.quietHoursTimezone),
    });
    return null;
  }

  const client = message.clientId ? await ctx.db.get(message.clientId) : null;

  /*
   * scheduledFor is set FORWARD to the reclaim deadline rather than left
   * alone. It means "the next moment this row wants attention", which for a
   * claimed row is the moment it should be assumed dead — and that lets the
   * stalled-row sweep below reuse `by_status_scheduledFor` instead of needing
   * a claimedAt column and an index of its own.
   */
  await ctx.db.patch(args.messageId, {
    status: "sending",
    attempts: message.attempts + 1,
    scheduledFor: args.now + SENDING_TIMEOUT_MS,
  });

  return {
    messageId: message._id,
    channel: message.channel,
    to: message.to,
    templateKey: message.templateKey,
    payload: message.payload,
    clientName: client?.name ?? "Your booking",
    timezone: message.quietHoursTimezone,
    attempts: message.attempts + 1,
    clientContactEmail: client?.primaryContactEmail ?? null,
  };
}

/**
 * Write down what the provider said.
 *
 * A retryable failure goes back in the queue on a backoff — pushed out of
 * quiet hours if the backoff lands in them, because a retry is a send and the
 * rules do not change on the second attempt.
 */
export async function recordSendResult(
  ctx: MutationCtx,
  args: { messageId: Id<"messages">; result: SendResult; now: number },
): Promise<void> {
  const message = await ctx.db.get(args.messageId);
  // Only a row this drain claimed may be resolved. A stalled row that was
  // requeued and re-sent by somebody else must not be overwritten by the
  // verdict of the attempt that stranded it.
  if (!message || message.status !== "sending") return;

  if (args.result.delivered) {
    await ctx.db.patch(args.messageId, {
      status: "sent",
      sentAt: args.now,
      scheduledFor: args.now,
      providerName: args.result.providerName,
      providerMessageId: args.result.providerMessageId,
      error: undefined,
    });
    return;
  }

  const exhausted = message.attempts >= MAX_ATTEMPTS;
  if (args.result.retryable && !exhausted) {
    const next = nextSendableAt(
      args.now + backoffFor(message.attempts),
      message.quietHoursTimezone,
    );
    await ctx.db.patch(args.messageId, {
      status: "scheduled",
      scheduledFor: next,
      providerName: args.result.providerName,
      // Kept while it retries, so the outbox can say what went wrong on the
      // attempt before rather than only after the last one.
      error: args.result.error,
    });
    return;
  }

  await ctx.db.patch(args.messageId, {
    status: "failed",
    scheduledFor: args.now,
    providerName: args.result.providerName,
    error: exhausted
      ? `Gave up after ${message.attempts} attempts. Last error: ${args.result.error}`
      : args.result.error,
  });
}

/**
 * Put a stranded row back in the queue. See SENDING_TIMEOUT_MS for why this
 * accepts the risk of a duplicate rather than the risk of silence.
 */
export async function requeueStalled(
  ctx: MutationCtx,
  args: { messageId: Id<"messages">; now: number },
): Promise<boolean> {
  const message = await ctx.db.get(args.messageId);
  if (!message || message.status !== "sending") return false;
  if (message.scheduledFor > args.now) return false;

  await ctx.db.patch(args.messageId, {
    status: "scheduled",
    scheduledFor: args.now,
    error:
      "A send was started and never finished — requeued. If the customer got two, " +
      "this is why.",
  });
  return true;
}
