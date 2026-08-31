import { v } from "convex/values";
import { byDesc } from "./lib/ordering";
import { ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { tenantQuery } from "./lib/functions";
import { dispatch, type DispatchResult } from "./lib/messaging";

/**
 * MESSAGE PRODUCERS.
 *
 * One internal mutation per message type. Each reads what it needs from the
 * record and hands `dispatch` a fully-derived message — callers never
 * assemble an idempotency key, because a key invented at a call site is a key
 * that differs from the one the retry produces.
 *
 * These are internalMutations: a message is queued by the system reacting to
 * something (a booking made, a cron reaching a reminder window), never by a
 * browser asking for one.
 *
 * NOTHING SENDS. There is no WhatsApp or SMS driver in this codebase. These
 * queue rows in the state a real sender would drain, and `messaging.test.ts`
 * asserts no row ever reaches "sent" — so a future driver has to face that
 * test rather than quietly making the pipeline look finished.
 */

const channel = v.union(v.literal("whatsapp"), v.literal("email"), v.literal("sms"));

export const queueBookingConfirmation = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    channel: v.optional(channel),
    /** Injectable so quiet-hours behaviour is testable without waiting. */
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<DispatchResult> => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      throw new ConvexError({ code: "NOT_FOUND", message: "No such booking." });
    }
    const client = await ctx.db.get(booking.clientId);
    if (!client) {
      throw new ConvexError({ code: "NOT_FOUND", message: "No such client." });
    }

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
      channel: args.channel ?? "whatsapp",
      templateKey: "booking_confirmation",
      payload: { startsAt: String(booking.startsAt) },
      /*
       * The SITE's timezone. Bookings collect a name and a phone and nothing
       * else, so there is no recipient timezone to use — see the field's own
       * comment in tables/messaging.ts.
       */
      quietHoursTimezone: client.timezone,
      now: args.now,
    });
  },
});

export const queueBookingReminder = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hoursBefore: v.union(v.literal(24), v.literal(1)),
    channel: v.optional(channel),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<DispatchResult> => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) {
      throw new ConvexError({ code: "NOT_FOUND", message: "No such booking." });
    }
    const client = await ctx.db.get(booking.clientId);
    if (!client) {
      throw new ConvexError({ code: "NOT_FOUND", message: "No such client." });
    }

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
      channel: args.channel ?? "whatsapp",
      templateKey: args.hoursBefore === 24 ? "reminder_24h" : "reminder_1h",
      payload: { startsAt: String(booking.startsAt) },
      quietHoursTimezone: client.timezone,
      now: args.now,
    });
  },
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
        customerId: row.customerId ?? null,
      }));
  },
});
