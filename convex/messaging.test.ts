import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { idempotencyKeyFor, isQuiet, nextSendableAt } from "./lib/messaging";

/**
 * THE MESSAGING PIPELINE.
 *
 * Four rules, one choke point: never twice, never to demo or seed, never
 * without consent, never at night. Every test here is about a failure that is
 * silent — a message that should have gone and did not, or one that went to
 * someone who never signed up.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

/** 2026-09-15, in UTC. Africa/Johannesburg is UTC+2 all year — no DST. */
const AT = (hourUtc: number) => Date.UTC(2026, 8, 15, hourUtc);
const JHB = "Africa/Johannesburg";

/**
 * A real client, service, customer and BOOKING — so the tests drive the same
 * producer a cron would, not a shim written for the tests.
 */
async function seed(h: Harness, over: { isSeed?: boolean; isDemo?: boolean } = {}) {
  const ids = await h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Alpha", slug: "alpha", status: "live",
      timezone: JHB, currency: "ZAR", featureFlags: {},
      isDemo: over.isDemo ?? false, isSeed: over.isSeed ?? false,
    });
    const locationId = await ctx.db.insert("locations", {
      clientId, name: "Hillcrest", addressLine: "12 Old Main Rd", suburb: "Hillcrest",
      city: "Durban", region: "KwaZulu-Natal", countryCode: "ZA",
      timezone: JHB, active: true,
    });
    const owner = await ctx.db.insert("users", { email: "owner@alpha.test" });
    await ctx.db.insert("memberships", {
      userId: owner, clientId, role: "owner", active: true, acceptedAt: Date.now(),
    });
    return { ventureId, clientId, locationId, owner };
  });

  const owner = asUser(h, ids.owner);
  const { customerId } = await owner.mutation(api.customers.upsertByPhone, {
    clientSlug: "alpha", name: "Thabo M", phone: "0825551234",
  });
  const { serviceId } = await owner.mutation(api.services.create, {
    clientSlug: "alpha", key: "assessment", name: "Assessment",
    durationMinutes: 60, priceCents: 95000,
  });
  const { bookingId } = await owner.mutation(api.bookings.book, {
    clientSlug: "alpha", locationId: ids.locationId, serviceId, customerId,
    startsAt: AT(9),
  });
  return { ...ids, owner, customerId, serviceId, bookingId };
}

const grantWhatsapp = (s: Awaited<ReturnType<typeof seed>>) =>
  s.owner.mutation(api.customers.recordConsent, {
    clientSlug: "alpha", customerId: s.customerId, channel: "whatsapp",
    state: "granted", lawfulBasis: "consent", source: "booking form",
  });

/** Drives the real producer a cron would call, not a shim for the tests. */
const send = (
  s: Awaited<ReturnType<typeof seed>>,
  over: { channel?: "whatsapp" | "email" | "sms"; now?: number } = {},
) =>
  s.owner.mutation(internal.messages.queueBookingConfirmation, {
    bookingId: s.bookingId,
    channel: over.channel,
    now: over.now ?? AT(8),
  });

describe("idempotency keys", () => {
  const booking = "k1234" as Id<"bookings">;

  test("a rescheduled booking is a NEW message, not a suppressed duplicate", () => {
    /*
     * The failure this whole design exists to prevent: if the key were
     * `booking:{id}:confirmation`, moving the time would reproduce it, the
     * message would be dropped as a duplicate, and the customer would arrive
     * at the old time having been told nothing.
     */
    const nine = idempotencyKeyFor({
      kind: "booking.confirmation", bookingId: booking, startsAt: AT(9), revision: 1,
    });
    const ten = idempotencyKeyFor({
      kind: "booking.confirmation", bookingId: booking, startsAt: AT(10), revision: 2,
    });
    expect(nine).not.toBe(ten);
  });

  test("moving BACK to the original time is still a new message", () => {
    // 09:00 -> 10:00 -> 09:00. startsAt alone repeats; the revision breaks it.
    const first = idempotencyKeyFor({
      kind: "booking.confirmation", bookingId: booking, startsAt: AT(9), revision: 1,
    });
    const back = idempotencyKeyFor({
      kind: "booking.confirmation", bookingId: booking, startsAt: AT(9), revision: 3,
    });
    expect(first).not.toBe(back);
  });

  test("the same booking at the same time and revision is ONE message", () => {
    const a = idempotencyKeyFor({
      kind: "booking.confirmation", bookingId: booking, startsAt: AT(9), revision: 1,
    });
    const b = idempotencyKeyFor({
      kind: "booking.confirmation", bookingId: booking, startsAt: AT(9), revision: 1,
    });
    expect(a).toBe(b);
  });

  test("reminders and confirmations for one booking do not collide", () => {
    const keys = new Set(
      (["booking.confirmation", "booking.reminder24", "booking.reminder1"] as const).map((kind) =>
        idempotencyKeyFor({ kind, bookingId: booking, startsAt: AT(9), revision: 1 }),
      ),
    );
    expect(keys.size).toBe(3);
  });

  test("quote follow-ups are three distinct messages", () => {
    const quoteId = "q1" as Id<"quotes">;
    const keys = new Set(
      ([2, 5, 10] as const).map((day) =>
        idempotencyKeyFor({ kind: "quote.followup", quoteId, day }),
      ),
    );
    expect(keys.size).toBe(3);
  });
});

describe("quiet hours use the SITE's timezone", () => {
  test("03:00 local is quiet, 09:00 local is not", () => {
    // JHB is UTC+2, so 01:00 UTC is 03:00 local and 07:00 UTC is 09:00 local.
    expect(isQuiet(AT(1), JHB)).toBe(true);
    expect(isQuiet(AT(7), JHB)).toBe(false);
  });

  test("a night message is HELD until morning, never dropped", () => {
    // Dropping it means the customer is never reminded at all.
    const held = nextSendableAt(AT(1), JHB);
    expect(held).toBeGreaterThan(AT(1));
    expect(isQuiet(held, JHB)).toBe(false);
  });

  test("the same instant is quiet in one timezone and not another", () => {
    /*
     * Proves the approximation is real rather than theoretical: quiet hours
     * are evaluated against the SITE's timezone, so a recipient abroad is
     * judged by the business's clock, not their own. There is no recipient
     * timezone anywhere to do better with.
     */
    /*
     * 19:00 UTC is 21:00 in Johannesburg — quiet — and 15:00 in New York,
     * which is not. A customer in New York booking with a Durban business
     * gets their message held until Durban's morning, which is the middle of
     * their afternoon.
     *
     * An earlier version of this test used 17:00 UTC and asserted JHB was
     * quiet. It is 19:00 there, an hour before the threshold, so the test was
     * wrong rather than the code.
     */
    expect(isQuiet(AT(19), JHB)).toBe(true);
    expect(isQuiet(AT(19), "America/New_York")).toBe(false);
    // And the reverse, so this is not one-directional luck.
    expect(isQuiet(AT(1), JHB)).toBe(true);
    expect(isQuiet(AT(11), JHB)).toBe(false);
    expect(isQuiet(AT(11), "America/New_York")).toBe(true);
  });
});

describe("the choke point", () => {
  test("queues a message when consent is granted and it is daytime", async () => {
    const h = harness();
    const s = await seed(h);
    await grantWhatsapp(s);

    const result = await send(s);
    expect(result.outcome).toBe("queued");

    const rows = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("scheduled");
    expect(rows[0]!.quietHoursTimezone).toBe(JHB);
  });

  test("NEVER TWICE — the same key returns the first message", async () => {
    const h = harness();
    const s = await seed(h);
    await grantWhatsapp(s);

    const first = await send(s);
    const second = await send(s);
    expect(second.outcome).toBe("duplicate");

    const rows = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(rows).toHaveLength(1);
    expect(first.outcome).toBe("queued");
  });

  test("NEVER WITHOUT CONSENT — absent is not granted", async () => {
    // A customer who has never been asked has not agreed.
    const h = harness();
    const s = await seed(h);

    const result = await send(s);
    expect(result.outcome).toBe("suppressed_consent");

    // A row is still written: an invisible drop is indistinguishable from a bug.
    const rows = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(rows[0]!.status).toBe("suppressed_consent");
  });

  test("a withdrawn consent suppresses, even after it was granted", async () => {
    const h = harness();
    const s = await seed(h);
    await grantWhatsapp(s);
    await s.owner.mutation(api.customers.recordConsent, {
      clientSlug: "alpha", customerId: s.customerId, channel: "whatsapp",
      state: "withdrawn", lawfulBasis: "consent", source: "asked us to stop",
    });

    const result = await send(s);
    expect(result.outcome).toBe("suppressed_consent");
  });

  test("consent is per CHANNEL — WhatsApp does not grant email", async () => {
    const h = harness();
    const s = await seed(h);
    await grantWhatsapp(s);

    const result = await send(s, { channel: "email" });
    expect(result.outcome).toBe("suppressed_consent");
  });

  test("held over quiet hours rather than dropped", async () => {
    const h = harness();
    const s = await seed(h);
    await grantWhatsapp(s);

    const result = await send(s, { now: AT(1) });
    expect(result.outcome).toBe("queued");
    if (result.outcome !== "queued") throw new Error("unreachable");
    expect(result.held).toBe(true);
    expect(result.scheduledFor).toBeGreaterThan(AT(1));

    const rows = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(rows[0]!.status).toBe("holding_quiet_hours");
  });
});

describe("demo and seed data can never be reached", () => {
  test("a SEEDED client is unreachable even with consent granted", async () => {
    /*
     * The blocking lives in dispatch, not at each caller, so this holds for
     * every path that exists and every path anyone adds. guards.test.ts is
     * what keeps it the only path.
     */
    const h = harness();
    const s = await seed(h, { isSeed: true });
    await grantWhatsapp(s);

    const result = await send(s);
    expect(result.outcome).toBe("suppressed_demo");

    const rows = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(rows[0]!.status).toBe("suppressed_demo");
    expect(rows[0]!.sentAt).toBeUndefined();
  });

  test("a DEMO client is unreachable even with consent granted", async () => {
    const h = harness();
    const s = await seed(h, { isDemo: true });
    await grantWhatsapp(s);

    await expect(send(s)).resolves.toMatchObject({ outcome: "suppressed_demo" });
  });

  test("demo blocking beats consent — it is checked first", async () => {
    // Order matters for the audit trail: a seeded row should read as
    // suppressed_demo, not suppressed_consent, or the reason is wrong.
    const h = harness();
    const s = await seed(h, { isSeed: true });

    const result = await send(s);
    expect(result.outcome).toBe("suppressed_demo");
  });

  test("no message row anywhere reaches 'sent' — there is no provider", async () => {
    /*
     * Nothing in this codebase can mark a message sent, because no driver
     * exists. Asserted so that a future driver has to face this test rather
     * than quietly making the pipeline look complete.
     */
    const h = harness();
    const s = await seed(h);
    await grantWhatsapp(s);
    await send(s);

    const rows = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(rows.every((r) => r.status !== "sent" && r.status !== "delivered")).toBe(true);
  });
});

describe("consent when two rows tie", () => {
  test("an EXACT tie resolves to withdrawn", async () => {
    /*
     * CI caught this as a test that passed locally and failed on the runner:
     * a grant and a withdrawal recorded in the same millisecond sort equally,
     * and the scan order that broke the tie was not guaranteed.
     *
     * The tie-break is deliberately the OPPOSITE of this codebase's messaging
     * default. "Prefer sending twice over suppressing" is right when the cost
     * is a duplicate. It is wrong here: guessing "granted" messages someone
     * who asked us to stop. Ambiguous consent is not consent.
     */
    const h = harness();
    const s = await seed(h);

    const sameInstant = AT(8);
    await h.run(async (ctx) => {
      for (const state of ["granted", "withdrawn"] as const) {
        await ctx.db.insert("consents", {
          clientId: s.clientId, customerId: s.customerId, channel: "whatsapp",
          state, lawfulBasis: "consent", source: "same millisecond", at: sameInstant,
        });
      }
    });

    const state = await s.owner.query(api.customers.consentState, {
      clientSlug: "alpha", customerId: s.customerId,
    });
    expect(state.whatsapp).toBe("withdrawn");

    // And the send path must agree — one helper, so they cannot diverge.
    await expect(send(s)).resolves.toMatchObject({ outcome: "suppressed_consent" });
  });

  test("reversing the insert order does not change the answer", async () => {
    // The bug was order-dependence. This is the same scenario, inverted.
    const h = harness();
    const s = await seed(h);

    const sameInstant = AT(8);
    await h.run(async (ctx) => {
      for (const state of ["withdrawn", "granted"] as const) {
        await ctx.db.insert("consents", {
          clientId: s.clientId, customerId: s.customerId, channel: "whatsapp",
          state, lawfulBasis: "consent", source: "same millisecond", at: sameInstant,
        });
      }
    });

    const state = await s.owner.query(api.customers.consentState, {
      clientSlug: "alpha", customerId: s.customerId,
    });
    expect(state.whatsapp).toBe("withdrawn");
  });

  test("a later grant still wins when the times differ", async () => {
    // The tie-break must not become "withdrawn always wins".
    const h = harness();
    const s = await seed(h);

    await h.run(async (ctx) => {
      await ctx.db.insert("consents", {
        clientId: s.clientId, customerId: s.customerId, channel: "whatsapp",
        state: "withdrawn", lawfulBasis: "consent", source: "older", at: AT(6),
      });
      await ctx.db.insert("consents", {
        clientId: s.clientId, customerId: s.customerId, channel: "whatsapp",
        state: "granted", lawfulBasis: "consent", source: "newer", at: AT(7),
      });
    });

    const state = await s.owner.query(api.customers.consentState, {
      clientSlug: "alpha", customerId: s.customerId,
    });
    expect(state.whatsapp).toBe("granted");
    await expect(send(s)).resolves.toMatchObject({ outcome: "queued" });
  });
});
