import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * OVERLAP SAFETY.
 *
 * The claim under test: two people cannot take the same slot. Everything else
 * in this file exists to pin down the edges of that claim — buffers, released
 * slots, block-outs, and the bound that makes the overlap query correct at
 * all.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

const AT = (hour: number, minute = 0) => Date.UTC(2026, 8, 15, hour, minute);

async function seed(h: Harness, serviceOver: Record<string, unknown> = {}) {
  const ids = await h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Alpha", slug: "alpha", status: "live",
      timezone: "Africa/Johannesburg", currency: "ZAR",
      featureFlags: {}, isDemo: false, isSeed: false,
    });
    const locationId = await ctx.db.insert("locations", {
      clientId, name: "Hillcrest", addressLine: "12 Old Main Rd", suburb: "Hillcrest",
      city: "Durban", region: "KwaZulu-Natal", countryCode: "ZA",
      timezone: "Africa/Johannesburg", active: true,
    });
    const owner = await ctx.db.insert("users", { email: "owner@alpha.test" });
    await ctx.db.insert("memberships", {
      userId: owner, clientId, role: "owner", active: true, acceptedAt: Date.now(),
    });
    return { clientId, locationId, owner };
  });

  const owner = asUser(h, ids.owner);
  const { serviceId } = await owner.mutation(api.services.create, {
    clientSlug: "alpha", key: "assessment", name: "Assessment",
    durationMinutes: 60, priceCents: 95000, ...serviceOver,
  });
  const { customerId } = await owner.mutation(api.customers.upsertByPhone, {
    clientSlug: "alpha", name: "Thabo M", phone: "0825551234",
  });
  const { customerId: other } = await owner.mutation(api.customers.upsertByPhone, {
    clientSlug: "alpha", name: "Nomsa K", phone: "0835559999",
  });

  return { ...ids, owner, serviceId, customerId, otherCustomerId: other };
}

describe("two people cannot take the same slot", () => {
  test("the second booking is refused", async () => {
    const h = harness();
    const s = await seed(h);

    await s.owner.mutation(api.bookings.book, {
      clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
      customerId: s.customerId, startsAt: AT(9),
    });

    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.otherCustomerId, startsAt: AT(9),
      }),
    ).rejects.toThrow(/SLOT_TAKEN/);
  });

  test("two interleaved attempts produce exactly one booking", async () => {
    /*
     * Both promises are started before either is awaited, so the calls
     * interleave as far as the harness allows, and the invariant holds: one
     * succeeds, one is refused, one row exists.
     *
     * BUT READ THIS BEFORE TRUSTING IT AS A CONCURRENCY TEST. It is not one.
     * Probed 31 Aug 2026: the loser fails with SLOT_TAKEN, not with a write
     * conflict, which means convex-test SERIALISED the two mutations — the
     * second ran after the first committed and simply saw it. This asserts
     * exactly what the sequential test above asserts.
     *
     * The actual concurrency guarantee is structural, not covered here:
     * Convex mutations are serializable, and `book` reads the target window
     * through an INDEXED RANGE that contains anything it could conflict with,
     * so that read joins the transaction's read set. A racing insert into
     * that range invalidates it, and the loser is retried against the new
     * state, re-reads, and takes the SLOT_TAKEN path above.
     *
     * What would actually exercise the retry path is two processes against a
     * real deployment. Until that exists, do not describe this file as
     * proving overlap safety under concurrency — it proves the check is
     * right, and the read-set design is what makes the check sufficient.
     */
    const h = harness();
    const s = await seed(h);

    const attempt = (customerId: Id<"customers">) =>
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId, startsAt: AT(11),
      });

    const results = await Promise.allSettled([
      attempt(s.customerId),
      attempt(s.otherCustomerId),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const rows = await h.run((ctx) => ctx.db.query("bookings").collect());
    expect(rows).toHaveLength(1);
  });

  test("a partial overlap is still an overlap", async () => {
    const h = harness();
    const s = await seed(h);
    await s.owner.mutation(api.bookings.book, {
      clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
      customerId: s.customerId, startsAt: AT(9),
    });

    // Starts 30 minutes into a 60-minute job.
    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.otherCustomerId, startsAt: AT(9, 30),
      }),
    ).rejects.toThrow(/SLOT_TAKEN/);
  });

  test("back-to-back is allowed — touching is not overlapping", async () => {
    const h = harness();
    const s = await seed(h);
    await s.owner.mutation(api.bookings.book, {
      clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
      customerId: s.customerId, startsAt: AT(9),
    });

    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.otherCustomerId, startsAt: AT(10),
      }),
    ).resolves.toMatchObject({ startsAt: AT(10) });
  });
});

describe("buffers are not free time", () => {
  test("a job cannot start inside another job's drive time", async () => {
    /*
     * 60-minute job at 09:00 with 15 minutes either side occupies
     * 08:45–10:15. A 10:00 start looks free on the raw window and is not.
     */
    const h = harness();
    const s = await seed(h, { bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });

    await s.owner.mutation(api.bookings.book, {
      clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
      customerId: s.customerId, startsAt: AT(9),
    });

    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.otherCustomerId, startsAt: AT(10),
      }),
    ).rejects.toThrow(/SLOT_TAKEN/);
  });

  test("clear of both buffers is allowed", async () => {
    const h = harness();
    const s = await seed(h, { bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
    await s.owner.mutation(api.bookings.book, {
      clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
      customerId: s.customerId, startsAt: AT(9),
    });

    // 08:45–10:15 is held; the next clear start is 10:30 (its own 15 before).
    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.otherCustomerId, startsAt: AT(10, 30),
      }),
    ).resolves.toBeTruthy();
  });
});

describe("what releases a slot", () => {
  test("cancelling frees the time; the row survives", async () => {
    const h = harness();
    const s = await seed(h);
    const { bookingId } = await s.owner.mutation(api.bookings.book, {
      clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
      customerId: s.customerId, startsAt: AT(9),
    });

    await s.owner.mutation(api.bookings.setStatus, {
      clientSlug: "alpha", bookingId, status: "cancelled",
    });

    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.otherCustomerId, startsAt: AT(9),
      }),
    ).resolves.toBeTruthy();

    // History is kept — a no-show count and a Client-360 are built from it.
    const rows = await h.run((ctx) => ctx.db.query("bookings").collect());
    expect(rows).toHaveLength(2);
  });

  test("a completed booking still holds its slot", async () => {
    const h = harness();
    const s = await seed(h);
    const { bookingId } = await s.owner.mutation(api.bookings.book, {
      clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
      customerId: s.customerId, startsAt: AT(9),
    });
    await s.owner.mutation(api.bookings.setStatus, {
      clientSlug: "alpha", bookingId, status: "completed",
    });

    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.otherCustomerId, startsAt: AT(9),
      }),
    ).rejects.toThrow(/SLOT_TAKEN/);
  });

  test("a no-show is counted on the customer", async () => {
    const h = harness();
    const s = await seed(h);
    const { bookingId } = await s.owner.mutation(api.bookings.book, {
      clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
      customerId: s.customerId, startsAt: AT(9),
    });
    await s.owner.mutation(api.bookings.setStatus, {
      clientSlug: "alpha", bookingId, status: "no_show",
    });

    const customer = await h.run((ctx) => ctx.db.get(s.customerId));
    expect(customer?.noShowCount).toBe(1);
  });
});

describe("block-outs", () => {
  test("occupy the calendar like a booking", async () => {
    const h = harness();
    const s = await seed(h);
    await s.owner.mutation(api.bookings.blockOut, {
      clientSlug: "alpha", locationId: s.locationId,
      startsAt: AT(9), endsAt: AT(12), reason: "Public holiday",
    });

    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.customerId, startsAt: AT(10),
      }),
    ).rejects.toThrow(/BLOCKED/);
  });

  test("need a reason — the calendar has to say why it is closed", async () => {
    const h = harness();
    const s = await seed(h);
    await expect(
      s.owner.mutation(api.bookings.blockOut, {
        clientSlug: "alpha", locationId: s.locationId,
        startsAt: AT(9), endsAt: AT(12), reason: "  ",
      }),
    ).rejects.toThrow(/INVALID/);
  });
});

describe("what cannot be booked", () => {
  test("a quote-only service", async () => {
    const h = harness();
    const s = await seed(h, { priceCents: undefined, quoteRequired: true });
    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.customerId, startsAt: AT(9),
      }),
    ).rejects.toThrow(/QUOTE_REQUIRED/);
  });

  test("a booking longer than the lookback that makes the query correct", async () => {
    /*
     * 25 hours would start before the window the overlap query reads and run
     * into it, so it could double-book undetected. Refusing it is what makes
     * the range provably sufficient rather than usually sufficient.
     */
    const h = harness();
    const s = await seed(h, { durationMinutes: 25 * 60 });
    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.customerId, startsAt: AT(9),
      }),
    ).rejects.toThrow(/BOOKING_TOO_LONG/);
  });

  test("a merged-away customer", async () => {
    const h = harness();
    const s = await seed(h);
    await s.owner.mutation(api.customers.merge, {
      clientSlug: "alpha", keepId: s.customerId, mergeId: s.otherCustomerId,
    });

    await expect(
      s.owner.mutation(api.bookings.book, {
        clientSlug: "alpha", locationId: s.locationId, serviceId: s.serviceId,
        customerId: s.otherCustomerId, startsAt: AT(9),
      }),
    ).rejects.toThrow(/CUSTOMER_MERGED/);
  });
});
