import { v, ConvexError } from "convex/values";
import { byAsc } from "./lib/ordering";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { tenantQuery, tenantMutation } from "./lib/functions";
import { assertOwned, assertLocationAllowed, auditWrite } from "./lib/tenancy";
import {
  establishTransactionalConsent,
  queueBookingConfirmationFor,
  transactionalChannelFor,
} from "./messages";
import { idempotencyKeyFor, type DispatchResult } from "./lib/messaging";
import { localDayKey, startOfLocalDay, startOfLocalDayPlus } from "./lib/localDay";
import { patchDoc } from "./lib/db";

/**
 * BOOKINGS — overlap-safe by construction.
 *
 * THE GUARANTEE: two people cannot take the same slot, even if they tap
 * "confirm" in the same millisecond.
 *
 * How it holds. Convex mutations are serializable. This mutation READS the
 * target window through `by_location_start` and WRITES into that same window
 * in one transaction, so the read is part of the transaction's read set. Two
 * concurrent bookings for the same slot therefore conflict: one commits, the
 * other is retried against the new state, re-reads, finds the first, and is
 * refused. There is no lock, no held row, and no "check then insert" gap —
 * the gap is what a serializable transaction removes.
 *
 * NOT PROVEN BY THE TEST SUITE. convex-test serialises mutations, so the
 * "interleaved" test in bookings.test.ts exercises the sequential path and
 * never the retry. The guarantee above is structural — it rests on Convex's
 * serializability and on the read below being an indexed range, not on a test
 * having demonstrated it. Two processes against a real deployment is what
 * would demonstrate it.
 *
 * That only works if the read RANGE provably contains anything that could
 * overlap. An index range on `startsAt` alone would miss a long booking that
 * started before the window and runs into it, so the lower bound is widened
 * by MAX_BOOKING_MS and bookings longer than that are refused at the write.
 * The refusal is what makes the range sufficient rather than merely usually
 * sufficient.
 *
 * BUFFERS ARE NOT FREE TIME. A booking stores the customer-facing appointment
 * window; the slot it consumes is that window expanded by the service's
 * before/after buffers. Overlap is tested on the EXPANDED windows of both
 * sides, so a 15-minute drive out of one job cannot be the 15 minutes another
 * job starts in.
 */

/**
 * The longest a single booking may run. Also the lookback that makes the
 * overlap query correct — raise one and you must raise the other, which is
 * why they are the same constant.
 */
const MAX_BOOKING_MS = 24 * 60 * 60 * 1000;

export type BookingRow = {
  _id: Id<"bookings">;
  startsAt: number;
  endsAt: number;
  status: "pending" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show";
  source: "site" | "back_office" | "phone" | "import";
  serviceId: Id<"services">;
  serviceName: string;
  customerId: Id<"customers">;
  customerName: string;
  customerPhone: string;
  locationId: Id<"locations">;
  staffUserId: Id<"users"> | null;
  notes: string | null;
  isDemo: boolean;
};

/** A cancelled or no-show booking releases its slot. Nothing else does. */
const HOLDS_A_SLOT = ["pending", "confirmed", "in_progress", "completed"] as const;
const holdsSlot = (status: string) => (HOLDS_A_SLOT as readonly string[]).includes(status);

/**
 * What the person who just took the booking needs to know about the
 * confirmation, in a sentence they can act on.
 *
 * `queued` is the ordinary case and says nothing more than that. Every other
 * outcome is a customer who will not hear from us, and the moment to say so is
 * now — while whoever is on the phone to them can still ask for an email
 * address or record consent. Discovered in the outbox three days later, it is
 * only a record of a missed opportunity.
 */
function describe(result: DispatchResult): { queued: boolean; notice: string | null } {
  switch (result.outcome) {
    case "queued":
      return { queued: true, notice: null };
    case "duplicate":
      return { queued: true, notice: null };
    case "no_destination":
      return {
        queued: false,
        notice:
          "No confirmation was sent — we have no email address for this customer. " +
          "Add one and they will get their reminders too.",
      };
    case "suppressed_consent":
      return {
        queued: false,
        notice:
          "No confirmation was sent — this customer has not agreed to be contacted " +
          "on this channel, or has asked us to stop.",
      };
    case "suppressed_lead":
      /*
       * Loud, and it names the business. This one is not a normal state of
       * affairs like a missing consent — it means a customer record was
       * created against a business we are PROSPECTING, and whoever is looking
       * at this screen is the only person who can say whether that was a
       * mistake or a genuine coincidence of numbers.
       */
      return {
        queued: false,
        notice: `No confirmation was sent — ${result.reason}`,
      };
    case "suppressed_demo":
      return { queued: false, notice: "Demo data: nothing is sent to real people." };
  }
}

export const list = tenantQuery("staff")({
  args: {
    locationId: v.optional(v.id("locations")),
    from: v.number(),
    to: v.number(),
  },
  handler: async (ctx, { locationId, from, to }): Promise<BookingRow[]> => {
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_client_start", (q) =>
        q.eq("clientId", ctx.tenant.clientId).gte("startsAt", from).lt("startsAt", to),
      )
      .collect();

    const services = new Map(
      (
        await ctx.db
          .query("services")
          .withIndex("by_client", (q) => q.eq("clientId", ctx.tenant.clientId))
          .collect()
      ).map((doc) => [doc._id, doc]),
    );
    const customers = new Map(
      (
        await ctx.db
          .query("customers")
          .withIndex("by_client_phone", (q) => q.eq("clientId", ctx.tenant.clientId))
          .collect()
      ).map((doc) => [doc._id, doc]),
    );

    return rows
      .filter((row) => (locationId ? row.locationId === locationId : true))
      .sort(byAsc((row) => row.startsAt))
      .map((row) => ({
        _id: row._id,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        status: row.status,
        source: row.source,
        serviceId: row.serviceId,
        serviceName: services.get(row.serviceId)?.name ?? "Unknown service",
        customerId: row.customerId,
        customerName: customers.get(row.customerId)?.name ?? "Unknown customer",
        customerPhone: customers.get(row.customerId)?.phone ?? "",
        locationId: row.locationId,
        staffUserId: row.staffUserId ?? null,
        notes: row.notes ?? null,
        isDemo: row.isDemo,
      }));
  },
});

/**
 * THE BOOKING ITSELF, with no opinion about who is asking.
 *
 * Split out of `book` below when the first non-browser caller appeared. The
 * overlap guarantee, the 24-hour cap, the buffer arithmetic, the confirmation
 * queued in this same transaction — all of it lives here, so a second caller
 * gets the identical rules rather than a second implementation of them that
 * drifts. THE INSERT STAYS IN THIS FILE, which is what keeps the guard on
 * `startsAt` meaningful: one writer, one place that sets messageRevision.
 *
 * What is NOT here is authorisation. `req.clientId` is taken as already
 * established — `book` derives it from the caller's own memberships and this
 * function never sees an untrusted slug. It still checks that every document
 * belongs to that client, because a caller passing a mismatched pair should
 * be refused rather than trusted, but that is consistency, not access control.
 *
 * Nor is the audit row: `auditWrite` needs an actor, and this function does
 * not know who is acting. Every caller writes its own.
 */
export type BookingRequest = {
  clientId: Id<"clients">;
  locationId: Id<"locations">;
  serviceId: Id<"services">;
  customerId: Id<"customers">;
  startsAt: number;
  staffUserId?: Id<"users">;
  notes?: string;
  source?: "site" | "back_office" | "phone" | "import";
};

/** Consistency, not access control — see the note above. */
function ownedBy<T extends { clientId: Id<"clients"> }>(
  clientId: Id<"clients">,
  doc: T | null,
  what: string,
): T {
  if (!doc || doc.clientId !== clientId) {
    throw new ConvexError({ code: "NOT_FOUND", message: `No such ${what}.` });
  }
  return doc;
}

export async function createBooking(
  ctx: MutationCtx,
  req: BookingRequest,
): Promise<{
  bookingId: Id<"bookings">;
  startsAt: number;
  endsAt: number;
  /** Whether the customer will hear about it, and if not, why not. */
  confirmation: { queued: boolean; notice: string | null };
}> {
    const service = ownedBy(req.clientId, await ctx.db.get(req.serviceId), "service");
    const customer = ownedBy(req.clientId, await ctx.db.get(req.customerId), "customer");

    if (!service.active) {
      throw new ConvexError({
        code: "SERVICE_INACTIVE",
        message: `"${service.name}" is not being offered.`,
      });
    }
    if (service.quoteRequired && service.priceCents === undefined) {
      throw new ConvexError({
        code: "QUOTE_REQUIRED",
        message: `"${service.name}" is quoted, not booked. Send a quote first.`,
      });
    }
    if (customer.mergedIntoId) {
      throw new ConvexError({
        code: "CUSTOMER_MERGED",
        message: "That customer record was merged. Book the surviving record.",
      });
    }

    if (!Number.isFinite(req.startsAt)) {
      throw new ConvexError({ code: "INVALID", message: "That is not a valid time." });
    }

    const durationMs = service.durationMinutes * 60_000;
    const startsAt = req.startsAt;
    const endsAt = startsAt + durationMs;

    /*
     * The refusal that makes the overlap query correct. A booking longer than
     * the lookback could start before the window we read and run into it,
     * and we would not see it.
     */
    if (durationMs > MAX_BOOKING_MS) {
      throw new ConvexError({
        code: "BOOKING_TOO_LONG",
        message: "A single booking cannot exceed 24 hours. Split it into separate jobs.",
      });
    }

    // The slot actually consumed, buffers included.
    const holdFrom = startsAt - service.bufferBeforeMinutes * 60_000;
    const holdTo = endsAt + service.bufferAfterMinutes * 60_000;

    /*
     * THE TRANSACTIONAL READ. Everything that could possibly overlap must be
     * inside this range, or a concurrent write outside it would not conflict.
     */
    const windowFrom = holdFrom - MAX_BOOKING_MS;

    const nearby = await ctx.db
      .query("bookings")
      .withIndex("by_location_start", (q) =>
        q.eq("locationId", req.locationId).gte("startsAt", windowFrom).lt("startsAt", holdTo),
      )
      .collect();

    const services = new Map(
      (
        await ctx.db
          .query("services")
          .withIndex("by_client", (q) => q.eq("clientId", req.clientId))
          .collect()
      ).map((doc) => [doc._id, doc]),
    );

    for (const other of nearby) {
      if (!holdsSlot(other.status)) continue;

      /*
       * Expand the EXISTING booking by its own service's buffers too. A
       * 15-minute drive out of one job is not the 15 minutes another job may
       * start in, and only comparing raw windows would let exactly that
       * through.
       */
      const otherService = services.get(other.serviceId);
      const otherFrom = other.startsAt - (otherService?.bufferBeforeMinutes ?? 0) * 60_000;
      const otherTo = other.endsAt + (otherService?.bufferAfterMinutes ?? 0) * 60_000;

      // Half-open intervals: a job ending exactly when the next begins is fine.
      if (otherFrom < holdTo && holdFrom < otherTo) {
        throw new ConvexError({
          code: "SLOT_TAKEN",
          message: "That time is no longer available. Pick another slot.",
        });
      }

      if (req.staffUserId && other.staffUserId === req.staffUserId) {
        if (otherFrom < holdTo && holdFrom < otherTo) {
          throw new ConvexError({
            code: "STAFF_BUSY",
            message: "That staff member is already booked then.",
          });
        }
      }
    }

    const blocks = await ctx.db
      .query("blockouts")
      .withIndex("by_location_start", (q) =>
        q.eq("locationId", req.locationId).gte("startsAt", windowFrom).lt("startsAt", holdTo),
      )
      .collect();

    for (const block of blocks) {
      if (block.startsAt < holdTo && holdFrom < block.endsAt) {
        throw new ConvexError({
          code: "BLOCKED",
          message: `Closed then: ${block.reason}`,
        });
      }
    }

    const client = await ctx.db.get(req.clientId);

    const bookingId = await ctx.db.insert("bookings", {
      clientId: req.clientId,
      locationId: req.locationId,
      customerId: req.customerId,
      serviceId: req.serviceId,
      staffUserId: req.staffUserId,
      startsAt,
      endsAt,
      // 1 at creation; any future reschedule must bump it, or the customer's
      // confirmation for the new time is suppressed as a duplicate.
      messageRevision: 1,
      status: "confirmed",
      source: req.source ?? "back_office",
      notes: req.notes?.trim() || undefined,
      isDemo: client?.isDemo ?? false,
    });

    /*
     * THE CONFIRMATION, IN THIS TRANSACTION.
     *
     * Not scheduled after the fact, and not left to a cron to notice. A
     * booking that committed while its confirmation did not is the exact
     * failure this whole pipeline is built against: the calendar says the
     * customer was told and the customer was not. One transaction makes it
     * both or neither.
     *
     * `dispatch` still decides whether it may go — consent, suppression, demo
     * and quiet hours are all applied there and none of them are re-stated
     * here. What comes back is the outcome, returned to the caller so the
     * person who just took the booking learns NOW that nothing will reach this
     * customer, while they can still ask for an email address. The same
     * reasoning as `reachable` on customers.upsertByPhone: the back end is the
     * only party that knows, so the back end says so.
     */
    const takenAt = Date.now();

    await establishTransactionalConsent(ctx, {
      clientId: req.clientId,
      customerId: customer._id,
      channel: transactionalChannelFor(customer),
      source: "made a booking",
      at: takenAt,
    });

    /*
     * `triggeredAt` is passed HERE and almost nowhere else, because this is
     * the one place in the codebase that watched a booking being taken. It is
     * what lets the confirmation interrupt quiet hours for an hour: somebody
     * who booked at 21:00 is waiting to hear that it worked, and silence after
     * an action reads as failure.
     *
     * It expires, so this is not a licence to send at 03:00 — see
     * INTERRUPT_WINDOW_MS.
     */
    const confirmation = await queueBookingConfirmationFor(ctx, {
      bookingId,
      triggeredAt: takenAt,
    });

    return { bookingId, startsAt, endsAt, confirmation: describe(confirmation) };
}

export const book = tenantMutation("staff")({
  args: {
    locationId: v.id("locations"),
    serviceId: v.id("services"),
    customerId: v.id("customers"),
    startsAt: v.number(),
    staffUserId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    source: v.optional(
      v.union(
        v.literal("site"),
        v.literal("back_office"),
        v.literal("phone"),
        v.literal("import"),
      ),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    bookingId: Id<"bookings">;
    startsAt: number;
    endsAt: number;
    confirmation: { queued: boolean; notice: string | null };
  }> => {
    /*
     * The two things that ARE about who is asking, and so stay here rather
     * than moving into createBooking: the tenant is re-derived from the
     * caller's own memberships by the constructor, and a staff member confined
     * to one branch may not book at another.
     */
    const location = assertOwned(ctx.tenant, await ctx.db.get(args.locationId));
    assertLocationAllowed(ctx.tenant, location._id);

    const result = await createBooking(ctx, { ...args, clientId: ctx.tenant.clientId });

    await auditWrite(ctx, ctx.tenant, {
      action: "booking.create",
      entityTable: "bookings",
      entityId: result.bookingId,
      after: {
        startsAt: result.startsAt,
        endsAt: result.endsAt,
        serviceId: args.serviceId,
        customerId: args.customerId,
      },
    });

    return result;
  },
});


/**
 * Cancelling RELEASES the slot, which is why status is checked on the way in
 * rather than the row being deleted: the history is what a no-show count and
 * a Client-360 are built from.
 */
export const setStatus = tenantMutation("staff")({
  args: {
    bookingId: v.id("bookings"),
    status: v.union(
      v.literal("pending"),
      v.literal("confirmed"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("no_show"),
    ),
  },
  handler: async (ctx, { bookingId, status }): Promise<{ bookingId: Id<"bookings"> }> => {
    const booking = assertOwned(ctx.tenant, await ctx.db.get(bookingId));
    await patchDoc(ctx, bookingId, { status });

    /*
     * A no-show is remembered on the customer, because the third one is a
     * business decision and nobody can make it from memory.
     */
    if (status === "no_show" && booking.status !== "no_show") {
      const customer = await ctx.db.get(booking.customerId);
      if (customer) {
        await patchDoc(ctx, customer._id, { noShowCount: customer.noShowCount + 1 });
      }
    }

    await auditWrite(ctx, ctx.tenant, {
      action: "booking.setStatus",
      entityTable: "bookings",
      entityId: bookingId,
      before: { status: booking.status },
      after: { status },
    });

    return { bookingId };
  },
});

export const blockOut = tenantMutation("manager")({
  args: {
    locationId: v.id("locations"),
    startsAt: v.number(),
    endsAt: v.number(),
    reason: v.string(),
    staffUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<{ blockoutId: Id<"blockouts"> }> => {
    const location = assertOwned(ctx.tenant, await ctx.db.get(args.locationId));
    assertLocationAllowed(ctx.tenant, location._id);

    if (args.endsAt <= args.startsAt) {
      throw new ConvexError({
        code: "INVALID_RANGE",
        message: "A block-out has to end after it starts.",
      });
    }
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError({
        code: "INVALID",
        message: "A block-out needs a reason — the calendar has to say why it is closed.",
      });
    }

    const blockoutId = await ctx.db.insert("blockouts", {
      clientId: ctx.tenant.clientId,
      locationId: args.locationId,
      staffUserId: args.staffUserId,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      reason,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "blockout.create",
      entityTable: "blockouts",
      entityId: blockoutId,
      after: { startsAt: args.startsAt, endsAt: args.endsAt, reason },
    });

    return { blockoutId };
  },
});

/**
 * THE CLIENT'S OWN CALENDAR — what is on today, and what is coming.
 *
 * The hole this closes: bookings arrive and confirmations go out, and until
 * now the person paying for the platform had no way to see either. That is
 * invisible on the day they go live, in front of them.
 *
 * TWO QUESTIONS, ONE SCREEN, because they are the same question to the person
 * asking. "What am I doing today" and "was the customer actually told" are
 * separated only in our heads — a booking whose confirmation silently failed
 * looks exactly like one that went out, and the customer is the one who finds
 * the difference.
 *
 * The confirmation lookup is EXACT, not a guess: `idempotencyKeyFor` is the
 * function that wrote the key, so asking it for the key again and reading the
 * index is the same join dispatch would make. Parsing keys or matching on
 * customer and time would drift the first time either changes.
 *
 * TODAY SHOWS CANCELLATIONS; the rest of the week does not. A job somebody saw
 * on this screen an hour ago that has since been called off has to be visibly
 * off, or they drive to it. A cancelled booking next Thursday is just noise.
 */
export const upcoming = tenantQuery("staff")({
  args: {
    /** Injectable so the day boundary is testable without waiting for midnight. */
    now: v.optional(v.number()),
    /** Days beyond today. Seven is a week of work; more is a planning tool. */
    days: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<UpcomingBookings> => {
    const now = args.now ?? Date.now();
    const timezone = ctx.tenant.client.timezone;
    const horizon = Math.min(Math.max(args.days ?? 6, 0), 30);

    const from = startOfLocalDay(now, timezone);
    const to = startOfLocalDayPlus(now, timezone, horizon + 1);
    const todayKey = localDayKey(now, timezone);

    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_client_start", (q) =>
        q.eq("clientId", ctx.tenant.clientId).gte("startsAt", from).lt("startsAt", to),
      )
      .collect();

    const services = new Map(
      (
        await ctx.db
          .query("services")
          .withIndex("by_client", (q) => q.eq("clientId", ctx.tenant.clientId))
          .collect()
      ).map((doc) => [doc._id, doc]),
    );
    const locations = new Map(
      (
        await ctx.db
          .query("locations")
          .withIndex("by_client", (q) => q.eq("clientId", ctx.tenant.clientId).eq("active", true))
          .collect()
      ).map((doc) => [doc._id, doc]),
    );

    const customers = new Map<string, Doc<"customers">>();
    for (const row of rows) {
      if (customers.has(row.customerId)) continue;
      const customer = await ctx.db.get(row.customerId);
      if (customer) customers.set(row.customerId, customer);
    }

    const ordered = rows.sort(byAsc((row) => row.startsAt));
    const built: UpcomingBooking[] = [];

    for (const row of ordered) {
      const dayKey = localDayKey(row.startsAt, timezone);
      const isToday = dayKey === todayKey;

      // A cancellation is news today and clutter next week. See the note above.
      if (!isToday && !HOLDS_A_SLOT_TODAY.includes(row.status)) continue;

      const customer = customers.get(row.customerId);
      built.push({
        _id: row._id,
        dayKey,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        status: row.status,
        serviceName: services.get(row.serviceId)?.name ?? "Appointment",
        locationName: locations.get(row.locationId)?.name ?? null,
        customerName: customer?.name ?? "Unknown customer",
        /*
         * E.164, which is what `tel:` wants and what a phone dials without
         * guessing at a country. `phoneDisplay` does not exist on a customer —
         * see lib/phone.ts on why the stored form is the key.
         */
        customerPhone: customer?.phone ?? null,
        notes: row.notes ?? null,
        confirmation: await confirmationFor(ctx, row),
      });
    }

    return {
      timezone,
      todayKey,
      today: built.filter((b) => b.dayKey === todayKey),
      /*
       * Grouped by DAY rather than handed over flat, because the grouping is a
       * fact about the client's timezone and doing it in the browser would be
       * doing it against the phone's.
       */
      days: groupByDay(built.filter((b) => b.dayKey !== todayKey)),
    };
  },
});

/** Statuses that still mean somebody is expected. */
const HOLDS_A_SLOT_TODAY: readonly string[] = ["pending", "confirmed", "in_progress", "completed"];

/**
 * Did the customer hear about it?
 *
 * `none` is not `not_sent`: no row at all means nothing was ever queued, which
 * is a different fault from a message that was queued and refused. The screen
 * says which, because the fixes are different — one is a bug, the other is
 * usually a missing email address.
 */
async function confirmationFor(
  ctx: QueryCtx,
  booking: Doc<"bookings">,
): Promise<UpcomingBooking["confirmation"]> {
  const key = idempotencyKeyFor({
    kind: "booking.confirmation",
    bookingId: booking._id,
    startsAt: booking.startsAt,
    revision: booking.messageRevision,
  });

  const message = await ctx.db
    .query("messages")
    .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key))
    .unique();

  if (!message) return { state: "none", detail: null, channel: null };

  switch (message.status) {
    case "sent":
    case "delivered":
      return { state: "sent", detail: null, channel: message.channel };
    case "scheduled":
    case "holding_quiet_hours":
    case "sending":
      return { state: "queued", detail: null, channel: message.channel };
    default:
      return {
        state: "not_sent",
        detail: message.error ?? "It was not sent.",
        channel: message.channel,
      };
  }
}

function groupByDay(bookings: UpcomingBooking[]): UpcomingDay[] {
  const days = new Map<string, UpcomingBooking[]>();
  for (const booking of bookings) {
    const list = days.get(booking.dayKey);
    if (list) list.push(booking);
    else days.set(booking.dayKey, [booking]);
  }
  return [...days.entries()].map(([dayKey, list]) => ({ dayKey, bookings: list }));
}

export type UpcomingBooking = {
  _id: Id<"bookings">;
  dayKey: string;
  startsAt: number;
  endsAt: number;
  status: "pending" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show";
  serviceName: string;
  locationName: string | null;
  customerName: string;
  customerPhone: string | null;
  notes: string | null;
  confirmation: {
    state: "sent" | "queued" | "not_sent" | "none";
    detail: string | null;
    channel: "whatsapp" | "email" | "sms" | null;
  };
};

export type UpcomingDay = { dayKey: string; bookings: UpcomingBooking[] };

export type UpcomingBookings = {
  /** The CLIENT's timezone. Every label on the screen is rendered in it. */
  timezone: string;
  todayKey: string;
  today: UpcomingBooking[];
  days: UpcomingDay[];
};
