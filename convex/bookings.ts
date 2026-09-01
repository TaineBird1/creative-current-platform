import { v, ConvexError } from "convex/values";
import { byAsc } from "./lib/ordering";
import type { Id } from "./_generated/dataModel";
import { tenantQuery, tenantMutation } from "./lib/functions";
import { assertOwned, assertLocationAllowed, auditWrite } from "./lib/tenancy";
import {
  establishTransactionalConsent,
  queueBookingConfirmationFor,
  transactionalChannelFor,
} from "./messages";
import type { DispatchResult } from "./lib/messaging";

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
    /** Whether the customer will hear about it, and if not, why not. */
    confirmation: { queued: boolean; notice: string | null };
  }> => {
    const location = assertOwned(ctx.tenant, await ctx.db.get(args.locationId));
    assertLocationAllowed(ctx.tenant, location._id);

    const service = assertOwned(ctx.tenant, await ctx.db.get(args.serviceId));
    const customer = assertOwned(ctx.tenant, await ctx.db.get(args.customerId));

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

    if (!Number.isFinite(args.startsAt)) {
      throw new ConvexError({ code: "INVALID", message: "That is not a valid time." });
    }

    const durationMs = service.durationMinutes * 60_000;
    const startsAt = args.startsAt;
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
        q.eq("locationId", args.locationId).gte("startsAt", windowFrom).lt("startsAt", holdTo),
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

      if (args.staffUserId && other.staffUserId === args.staffUserId) {
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
        q.eq("locationId", args.locationId).gte("startsAt", windowFrom).lt("startsAt", holdTo),
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

    const client = await ctx.db.get(ctx.tenant.clientId);

    const bookingId = await ctx.db.insert("bookings", {
      clientId: ctx.tenant.clientId,
      locationId: args.locationId,
      customerId: args.customerId,
      serviceId: args.serviceId,
      staffUserId: args.staffUserId,
      startsAt,
      endsAt,
      // 1 at creation; any future reschedule must bump it, or the customer's
      // confirmation for the new time is suppressed as a duplicate.
      messageRevision: 1,
      status: "confirmed",
      source: args.source ?? "back_office",
      notes: args.notes?.trim() || undefined,
      isDemo: client?.isDemo ?? false,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "booking.create",
      entityTable: "bookings",
      entityId: bookingId,
      after: { startsAt, endsAt, serviceId: args.serviceId, customerId: args.customerId },
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
    await establishTransactionalConsent(ctx, {
      clientId: ctx.tenant.clientId,
      customerId: customer._id,
      channel: transactionalChannelFor(customer),
      source: "made a booking",
      at: Date.now(),
    });

    const confirmation = await queueBookingConfirmationFor(ctx, { bookingId });

    return { bookingId, startsAt, endsAt, confirmation: describe(confirmation) };
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
    await ctx.db.patch(bookingId, { status });

    /*
     * A no-show is remembered on the customer, because the third one is a
     * business decision and nobody can make it from memory.
     */
    if (status === "no_show" && booking.status !== "no_show") {
      const customer = await ctx.db.get(booking.customerId);
      if (customer) {
        await ctx.db.patch(customer._id, { noShowCount: customer.noShowCount + 1 });
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
