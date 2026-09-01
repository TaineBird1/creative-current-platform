import { v } from "convex/values";
import { byDesc } from "./lib/ordering";
import { ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { tenantQuery } from "./lib/functions";
import { dispatch, type DispatchResult } from "./lib/messaging";
import { LIVE_CHANNELS, type MessageChannel } from "./lib/providers";

/**
 * MESSAGE PRODUCERS.
 *
 * One function per message type. Each reads what it needs from the record and
 * hands `dispatch` a fully-derived message — callers never assemble an
 * idempotency key, because a key invented at a call site is a key that differs
 * from the one the retry produces.
 *
 * Each comes in two forms: a plain helper, and an `internalMutation` wrapping
 * it. The helper exists so `bookings.book` can queue a confirmation IN THE
 * SAME TRANSACTION as the booking insert. That matters more than it looks: a
 * booking that committed while its confirmation did not is exactly the silent
 * failure — the calendar says the customer was told, and the customer was not.
 * One transaction means both or neither. The internalMutation form is for
 * callers that are not already in a transaction, which today means the
 * reminder cron.
 *
 * These are internal: a message is queued by the system reacting to something
 * — a booking made, a cron reaching a reminder window — never by a browser
 * asking for one.
 */

const channel = v.union(v.literal("whatsapp"), v.literal("email"), v.literal("sms"));

/**
 * WHICH CHANNEL A TRANSACTIONAL MESSAGE GOES OUT ON.
 *
 * Two facts decide it: what the customer gave us, and what the platform can
 * actually deliver on. Email is the only live driver today, so a customer with
 * an email address gets email.
 *
 * A customer with no email falls back to WhatsApp, which has no provider yet —
 * so that message is queued, logged, and recorded as not sent, with the reason
 * on the row. That is deliberate and it is the honest option: the alternative
 * is queueing nothing, which makes a customer we cannot reach look identical
 * to one we did reach. The outbox is meant to answer "did they hear from us",
 * and it can only do that if the ones we could not reach are in it.
 */
export function transactionalChannelFor(customer: Doc<"customers">): MessageChannel {
  if (customer.email?.trim() && LIVE_CHANNELS.includes("email")) return "email";
  return "whatsapp";
}

/**
 * A booking is a CONTRACT, and a confirmation of it is not marketing.
 *
 * Nothing else in this codebase writes a consent row except a staff member
 * recording one by hand, which means that before this existed, every booking
 * confirmation was suppressed for want of consent — a messaging pipeline that
 * ran end to end and reached nobody.
 *
 * So a booking establishes consent for the channel its confirmation will use,
 * on the `contract` lawful basis, sourced as the booking itself. POPIA s69
 * governs direct MARKETING; telling somebody the appointment they just asked
 * for is confirmed is not that, and the basis recorded here says so rather
 * than borrowing the word "consent" for something the customer never gave.
 *
 * IT NEVER OVERRIDES AN EXISTING ROW. If any row exists for this channel —
 * and in particular a withdrawal — this does nothing, so booking again can
 * never quietly undo somebody asking us to stop. That is the only thing that
 * makes writing a consent row on the customer's behalf defensible: it can
 * establish a basis where there was none, and it cannot reverse a refusal.
 */
export async function establishTransactionalConsent(
  ctx: MutationCtx,
  args: {
    clientId: Id<"clients">;
    customerId: Id<"customers">;
    channel: MessageChannel;
    source: string;
    at: number;
  },
): Promise<{ recorded: boolean }> {
  const existing = await ctx.db
    .query("consents")
    .withIndex("by_customer_channel", (q) =>
      q.eq("customerId", args.customerId).eq("channel", args.channel),
    )
    .first();
  if (existing) return { recorded: false };

  await ctx.db.insert("consents", {
    clientId: args.clientId,
    customerId: args.customerId,
    channel: args.channel,
    state: "granted",
    lawfulBasis: "contract",
    source: args.source,
    at: args.at,
  });
  return { recorded: true };
}

const notFound = (what: string) =>
  new ConvexError({ code: "NOT_FOUND", message: `No such ${what}.` });

/**
 * The number a customer should phone about THIS booking.
 *
 * The booking's own branch first, because a two-branch business has two
 * numbers and sending somebody the wrong one is worse than sending none — they
 * phone Hillcrest about a Ballito job and get told nothing is booked. The
 * client-level contact is the fallback, and absent is a real answer: the copy
 * drops the "phone us" half rather than printing a blank.
 *
 * This is in the PAYLOAD rather than read at send time because the producer is
 * the only thing that knows which branch the booking was at. By the drain it
 * is one row among twenty-five and the location is long gone.
 */
async function contactPayload(
  ctx: MutationCtx,
  args: { locationId: Id<"locations">; client: Doc<"clients"> },
): Promise<Record<string, string>> {
  const location = await ctx.db.get(args.locationId);
  const phone = location?.phone?.trim() || args.client.primaryContactPhone?.trim();
  return phone ? { contactPhone: phone } : {};
}

export async function queueBookingConfirmationFor(
  ctx: MutationCtx,
  args: { bookingId: Id<"bookings">; channel?: MessageChannel; now?: number },
): Promise<DispatchResult> {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking) throw notFound("booking");
  const client = await ctx.db.get(booking.clientId);
  if (!client) throw notFound("client");
  const customer = await ctx.db.get(booking.customerId);
  if (!customer) throw notFound("customer");

  const contact = await contactPayload(ctx, { locationId: booking.locationId, client });

  return dispatch(ctx, {
    message: {
      kind: "booking.confirmation",
      bookingId: booking._id,
      startsAt: booking.startsAt,
      // Carried from the booking, never recomputed. This is the field that
      // makes a reschedule a new message.
      revision: booking.messageRevision,
    },
    ventureId: client.ventureId,
    clientId: client._id,
    customerId: booking.customerId,
    channel: args.channel ?? transactionalChannelFor(customer),
    templateKey: "booking_confirmation",
    payload: { startsAt: String(booking.startsAt), ...contact },
    /*
     * The SITE's timezone. Bookings collect a name and a phone and nothing
     * else, so there is no recipient timezone to use — see the field's own
     * comment in tables/messaging.ts.
     */
    quietHoursTimezone: client.timezone,
    now: args.now,
  });
}

export async function queueBookingReminderFor(
  ctx: MutationCtx,
  args: {
    bookingId: Id<"bookings">;
    hoursBefore: 24 | 1;
    channel?: MessageChannel;
    now?: number;
  },
): Promise<DispatchResult> {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking) throw notFound("booking");
  const client = await ctx.db.get(booking.clientId);
  if (!client) throw notFound("client");
  const customer = await ctx.db.get(booking.customerId);
  if (!customer) throw notFound("customer");

  const contact = await contactPayload(ctx, { locationId: booking.locationId, client });

  return dispatch(ctx, {
    message: {
      kind: args.hoursBefore === 24 ? "booking.reminder24" : "booking.reminder1",
      bookingId: booking._id,
      startsAt: booking.startsAt,
      revision: booking.messageRevision,
    },
    ventureId: client.ventureId,
    clientId: client._id,
    customerId: booking.customerId,
    channel: args.channel ?? transactionalChannelFor(customer),
    templateKey: args.hoursBefore === 24 ? "reminder_24h" : "reminder_1h",
    payload: { startsAt: String(booking.startsAt), ...contact },
    quietHoursTimezone: client.timezone,
    now: args.now,
  });
}

export const queueBookingConfirmation = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    channel: v.optional(channel),
    /** Injectable so quiet-hours behaviour is testable without waiting. */
    now: v.optional(v.number()),
  },
  handler: (ctx, args): Promise<DispatchResult> => queueBookingConfirmationFor(ctx, args),
});

export const queueBookingReminder = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hoursBefore: v.union(v.literal(24), v.literal(1)),
    channel: v.optional(channel),
    now: v.optional(v.number()),
  },
  handler: (ctx, args): Promise<DispatchResult> => queueBookingReminderFor(ctx, args),
});

/**
 * The outbox. Staff need to answer "did they hear from us", and a suppressed
 * row answers it better than an absent one — which is why suppression writes
 * a row rather than returning silently.
 */
export const outbox = tenantQuery("staff")({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { limit },
  ): Promise<
    {
      _id: Id<"messages">;
      status: string;
      channel: string;
      templateKey: string;
      to: string;
      scheduledFor: number;
      sentAt: number | null;
      attempts: number;
      /** Why it did not go, in words, when it did not go. */
      error: string | null;
      providerName: string | null;
      customerId: Id<"customers"> | null;
    }[]
  > => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_client", (q) => q.eq("clientId", ctx.tenant.clientId))
      .collect();

    return rows
      .sort(byDesc((row) => row.scheduledFor))
      .slice(0, limit ?? 100)
      .map((row) => ({
        _id: row._id,
        status: row.status,
        channel: row.channel,
        templateKey: row.templateKey,
        to: row.to,
        scheduledFor: row.scheduledFor,
        sentAt: row.sentAt ?? null,
        attempts: row.attempts,
        error: row.error ?? null,
        providerName: row.providerName ?? null,
        customerId: row.customerId ?? null,
      }));
  },
});
