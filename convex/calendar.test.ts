import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { localDayKey, startOfLocalDay, startOfLocalDayPlus } from "./lib/localDay";

/**
 * THE CLIENT'S CALENDAR.
 *
 * Two things are being defended. First, that "today" means today WHERE THE
 * CLIENT IS — the server runs in UTC and the functions run in Dublin, so a
 * client in Durban opening this at 01:00 must not be shown yesterday. Second,
 * that the screen can answer "did the customer hear from us", because a
 * booking whose confirmation quietly failed looks exactly like one that went
 * out and the customer is who finds the difference.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const JHB = "Africa/Johannesburg";
const NY = "America/New_York";
/** 2026-09-02 in UTC. JHB is UTC+2 all year — no DST. */
const UTC = (hour: number, day = 2, minute = 0) => Date.UTC(2026, 8, day, hour, minute);

describe("the day boundary is the client's, not the server's", () => {
  test("23:00 UTC is already TOMORROW in Johannesburg", () => {
    // 23:00 UTC on the 2nd is 01:00 on the 3rd in JHB. A server-side day
    // boundary would put this booking on the wrong day, on the screen someone
    // uses to decide where to drive.
    expect(localDayKey(UTC(23), JHB)).toBe("2026-09-03");
    expect(localDayKey(UTC(23), "UTC")).toBe("2026-09-02");
  });

  test("and 01:00 UTC is still YESTERDAY in New York", () => {
    // The mirror, so this is not one-directional luck.
    expect(localDayKey(UTC(1), NY)).toBe("2026-09-01");
    expect(localDayKey(UTC(1), "UTC")).toBe("2026-09-02");
  });

  test("the start of the local day is local midnight, not UTC midnight", () => {
    const start = startOfLocalDay(UTC(12), JHB);
    // 22:00 UTC on the 1st IS 00:00 on the 2nd in Johannesburg.
    expect(start).toBe(Date.UTC(2026, 8, 1, 22));
    expect(localDayKey(start, JHB)).toBe("2026-09-02");
    // And the instant one millisecond earlier belongs to the day before.
    expect(localDayKey(start - 1, JHB)).toBe("2026-09-01");
  });

  test("stepping forward lands on local midnight every time", () => {
    for (let day = 0; day <= 7; day += 1) {
      const at = startOfLocalDayPlus(UTC(12), JHB, day);
      expect(localDayKey(at, JHB)).toBe(`2026-09-${String(2 + day).padStart(2, "0")}`);
      expect(at).toBe(startOfLocalDay(at, JHB));
    }
  });

  test("A DST ZONE STILL LANDS ON MIDNIGHT ACROSS THE SHIFT", () => {
    /*
     * The approximation this module admits to. New York leaves DST on
     * 2026-11-01, so a naive +24h from the day before lands at 23:00 rather
     * than midnight. Stepping re-derives from the anchor, which is what keeps
     * the boundary on the day.
     */
    const beforeShift = Date.UTC(2026, 9, 30, 16); // 2026-10-30, noon in NY
    for (let day = 0; day <= 4; day += 1) {
      const at = startOfLocalDayPlus(beforeShift, NY, day);
      expect(at).toBe(startOfLocalDay(at, NY));
    }
  });
});

async function setUp(h: Harness, timezone = JHB) {
  const ids = await h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Renu Solar", slug: "renu", status: "live",
      timezone, currency: "ZAR", featureFlags: {}, isDemo: false, isSeed: false,
    });
    const locationId = await ctx.db.insert("locations", {
      clientId, name: "Hillcrest", addressLine: "12 Old Main Rd", suburb: "Hillcrest",
      city: "Durban", region: "KwaZulu-Natal", countryCode: "ZA", timezone, active: true,
    });
    const ownerId = await ctx.db.insert("users", { email: "owner@renu.test" });
    await ctx.db.insert("memberships", {
      userId: ownerId, clientId, role: "owner", active: true, acceptedAt: UTC(6),
    });
    return { ventureId, clientId, locationId, ownerId };
  });

  const owner = h.withIdentity({ subject: `${ids.ownerId}|test-session` });
  const { serviceId } = await owner.mutation(api.services.create, {
    clientSlug: "renu", key: "assessment", name: "Site assessment",
    durationMinutes: 60, priceCents: 95000,
  });

  return { h, owner, ...ids, serviceId };
}

type Seeded = Awaited<ReturnType<typeof setUp>>;

/*
 * A COUNTER, not a slice of the timestamp. The first version derived the
 * phone from startsAt, and two bookings whole hours apart produced the same
 * trailing digits — so upsertByPhone merged them into ONE customer and the
 * second booking silently renamed the first. The test failed for a reason
 * that had nothing to do with what it was testing.
 */
let customerSeq = 0;

async function book(s: Seeded, startsAt: number, name: string, email?: string) {
  customerSeq += 1;
  const { customerId } = await s.owner.mutation(api.customers.upsertByPhone, {
    clientSlug: "renu", name, phone: `08255${String(customerSeq).padStart(5, "0")}`, email,
  });
  return s.owner.mutation(api.bookings.book, {
    clientSlug: "renu", locationId: s.locationId, serviceId: s.serviceId, customerId, startsAt,
  });
}

const upcoming = (s: Seeded, now: number) =>
  s.owner.query(api.bookings.upcoming, { clientSlug: "renu", now });

describe("what the client sees", () => {
  test("today is split from the week, by the CLIENT's clock", async () => {
    const s = await setUp(harness());
    // 08:00 JHB today, and 08:00 JHB in two days.
    await book(s, UTC(6), "Thabo Mokoena");
    await book(s, UTC(6, 4), "Sipho Khumalo");

    const view = await upcoming(s, UTC(4)); // 06:00 JHB
    expect(view.timezone).toBe(JHB);
    expect(view.today.map((b) => b.customerName)).toEqual(["Thabo Mokoena"]);
    expect(view.days).toHaveLength(1);
    expect(view.days[0]!.bookings[0]!.customerName).toBe("Sipho Khumalo");
  });

  test("A 23:30 BOOKING IS TODAY, NOT TOMORROW", async () => {
    /*
     * The failure a UTC day boundary produces: 23:30 in Johannesburg is
     * 21:30 UTC, which is the same UTC day — but the reverse case is what
     * bites, so this pins the late edge of the client's own day.
     */
    const s = await setUp(harness());
    await book(s, UTC(21, 2, 30), "Late Job");

    const view = await upcoming(s, UTC(4));
    expect(view.today.map((b) => b.customerName)).toEqual(["Late Job"]);
  });

  test("rows carry a name and a dialable number, in order", async () => {
    const s = await setUp(harness());
    await book(s, UTC(12), "Second");
    await book(s, UTC(6), "First");

    const view = await upcoming(s, UTC(4));
    expect(view.today.map((b) => b.customerName)).toEqual(["First", "Second"]);
    // E.164, which is what `tel:` dials without guessing at a country.
    expect(view.today[0]!.customerPhone).toMatch(/^\+27/);
    expect(view.today[0]!.serviceName).toBe("Site assessment");
    expect(view.today[0]!.locationName).toBe("Hillcrest");
  });

  test("A CANCELLATION STAYS ON TODAY AND VANISHES FROM THE WEEK", async () => {
    /*
     * A job somebody saw on this screen an hour ago that has since been called
     * off has to be visibly off, or they drive to it. A cancelled booking next
     * Thursday is just noise.
     */
    const s = await setUp(harness());
    const todayBooking = await book(s, UTC(6), "Called Off");
    const laterBooking = await book(s, UTC(6, 4), "Also Called Off");

    for (const b of [todayBooking, laterBooking]) {
      await s.owner.mutation(api.bookings.setStatus, {
        clientSlug: "renu", bookingId: b.bookingId, status: "cancelled",
      });
    }

    const view = await upcoming(s, UTC(4));
    expect(view.today.map((b) => b.status)).toEqual(["cancelled"]);
    expect(view.days).toEqual([]);
  });

  test("the horizon is bounded, so next month is not on this screen", async () => {
    const s = await setUp(harness());
    await book(s, UTC(6, 20), "Next Month");

    const view = await upcoming(s, UTC(4));
    expect(view.today).toEqual([]);
    expect(view.days).toEqual([]);
  });
});

describe("did the customer hear from us", () => {
  test("a confirmation that went out reads as sent", async () => {
    const s = await setUp(harness());
    const booked = await book(s, UTC(6), "Thabo Mokoena", "thabo@example.test");
    expect(booked.confirmation.queued).toBe(true);

    // Mark it delivered the way the drain would.
    await s.h.run(async (ctx) => {
      const message = await ctx.db.query("messages").first();
      await ctx.db.patch(message!._id, { status: "sent", sentAt: UTC(5) });
    });

    const view = await upcoming(s, UTC(4));
    expect(view.today[0]!.confirmation).toMatchObject({ state: "sent", channel: "email" });
  });

  test("one still queued reads as queued", async () => {
    const s = await setUp(harness());
    await book(s, UTC(6), "Thabo Mokoena", "thabo@example.test");

    const view = await upcoming(s, UTC(4));
    expect(view.today[0]!.confirmation.state).toBe("queued");
  });

  test("A REFUSED CONFIRMATION IS VISIBLE, not silence", async () => {
    // The whole reason this is on the screen. A booking whose confirmation
    // failed looks exactly like one that went out.
    const s = await setUp(harness());
    await book(s, UTC(6), "Thabo Mokoena", "thabo@example.test");

    await s.h.run(async (ctx) => {
      const message = await ctx.db.query("messages").first();
      await ctx.db.patch(message!._id, { status: "failed", error: "Resend refused it." });
    });

    const view = await upcoming(s, UTC(4));
    expect(view.today[0]!.confirmation.state).toBe("not_sent");
  });

  test("NO MESSAGE AT ALL IS ITS OWN ANSWER", async () => {
    /*
     * `none` is not `not_sent`. Nothing queued is a different fault from
     * something queued and refused, and the fixes differ — one is a bug, the
     * other is usually a missing address.
     */
    const s = await setUp(harness());
    await book(s, UTC(6), "Thabo Mokoena", "thabo@example.test");
    await s.h.run(async (ctx) => {
      const message = await ctx.db.query("messages").first();
      await ctx.db.delete(message!._id);
    });

    const view = await upcoming(s, UTC(4));
    expect(view.today[0]!.confirmation.state).toBe("none");
  });
});

describe("who may see it", () => {
  test("an unauthenticated caller cannot", async () => {
    const s = await setUp(harness());
    await expect(
      s.h.query(api.bookings.upcoming, { clientSlug: "renu" }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("A MEMBER OF ANOTHER CLIENT CANNOT, and cannot tell it apart from a typo", async () => {
    const s = await setUp(harness());
    const outsider = await s.h.run(async (ctx) => {
      const clientId = await ctx.db.insert("clients", {
        ventureId: s.ventureId, kind: "platform", name: "Other", slug: "other",
        status: "live", timezone: JHB, currency: "ZAR", featureFlags: {},
        isDemo: false, isSeed: false,
      });
      const userId = await ctx.db.insert("users", { email: "someone@other.test" });
      await ctx.db.insert("memberships", {
        userId, clientId, role: "owner", active: true, acceptedAt: UTC(6),
      });
      return userId;
    });

    await expect(
      s.h
        .withIdentity({ subject: `${outsider}|test-session` })
        .query(api.bookings.upcoming, { clientSlug: "renu" }),
    ).rejects.toThrow(/NOT_FOUND|FORBIDDEN/);
  });
});
