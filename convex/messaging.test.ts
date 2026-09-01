import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { idempotencyKeyFor, isQuiet, nextSendableAt } from "./lib/messaging";

/**
 * THE MESSAGING PIPELINE.
 *
 * Five rules, one choke point: never twice, never to demo or seed, never to a
 * LEAD, never without consent, never at night. Every test here is about a
 * failure that is silent — a message that should have gone and did not, or one
 * that went to someone who never signed up.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

/** 2026-09-15, in UTC. Africa/Johannesburg is UTC+2 all year — no DST. */
const AT = (hourUtc: number) => Date.UTC(2026, 8, 15, hourUtc);
const JHB = "Africa/Johannesburg";

type SeedOptions = {
  isSeed?: boolean;
  isDemo?: boolean;
  email?: string;
  /**
   * Consent rows written BEFORE the booking, which matters: `book` establishes
   * a contract basis only where no row exists, so anything set here is what
   * the booking finds and leaves alone.
   */
  consents?: { channel?: "whatsapp" | "email" | "sms"; state: "granted" | "withdrawn"; at: number }[];
};

/**
 * A real client, service, customer and BOOKING — so the tests drive the same
 * producers the office and the crons do, not a shim written for the tests.
 */
async function seed(h: Harness, over: SeedOptions = {}) {
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
    clientSlug: "alpha", name: "Thabo M", phone: "0825551234", email: over.email,
  });

  for (const row of over.consents ?? []) {
    await h.run((ctx) =>
      ctx.db.insert("consents", {
        clientId: ids.clientId, customerId, channel: row.channel ?? "whatsapp",
        state: row.state, lawfulBasis: "consent", source: "pre-existing", at: row.at,
      }),
    );
  }

  const { serviceId } = await owner.mutation(api.services.create, {
    clientSlug: "alpha", key: "assessment", name: "Assessment",
    durationMinutes: 60, priceCents: 95000,
  });
  const booking = await owner.mutation(api.bookings.book, {
    clientSlug: "alpha", locationId: ids.locationId, serviceId, customerId,
    startsAt: AT(9),
  });
  return { ...ids, owner, customerId, serviceId, bookingId: booking.bookingId, booking };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const grantWhatsapp = (s: Seeded) =>
  s.owner.mutation(api.customers.recordConsent, {
    clientSlug: "alpha", customerId: s.customerId, channel: "whatsapp",
    state: "granted", lawfulBasis: "consent", source: "booking form",
  });

/**
 * Drives a producer with an injectable `now`, which is what the quiet-hours
 * tests need.
 *
 * The REMINDER rather than the confirmation: booking now queues a confirmation
 * inside the booking transaction, so the confirmation's key is already taken
 * by the time a test runs and every call would come back `duplicate`. The
 * reminder goes through the same `dispatch` and the same four rules; only the
 * key differs.
 */
const send = (
  s: Seeded,
  over: { channel?: "whatsapp" | "email" | "sms"; now?: number } = {},
) =>
  s.owner.mutation(internal.messages.queueBookingReminder, {
    bookingId: s.bookingId,
    hoursBefore: 24,
    channel: over.channel,
    now: over.now ?? AT(8),
  });

const messagesIn = (h: Harness, templateKey: string) =>
  h.run(async (ctx) =>
    (await ctx.db.query("messages").collect()).filter((m) => m.templateKey === templateKey),
  );

const reminders = (h: Harness) => messagesIn(h, "reminder_24h");

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

describe("taking a booking is what tells the customer", () => {
  /**
   * The wiring, tested from the outside: nobody calls a producer, somebody
   * takes a booking. The confirmation has to be a consequence of that and not
   * of a second step anyone can forget.
   */
  test("booking queues the confirmation IN THE SAME MUTATION", async () => {
    const h = harness();
    const s = await seed(h);

    expect(s.booking.confirmation.queued).toBe(true);

    const rows = await messagesIn(h, "booking_confirmation");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toContain(s.bookingId);
  });

  test("A BOOKING ESTABLISHES A CONTRACT BASIS, NOT A CONSENT ONE", async () => {
    /*
     * Before this existed, every confirmation was suppressed for want of
     * consent — a pipeline that ran end to end and reached nobody. What the
     * customer actually did was ask for an appointment, so that is what the
     * row says: lawful basis `contract`, source "made a booking". Recording it
     * as `consent` would put a word in their mouth.
     */
    const h = harness();
    const s = await seed(h);

    const rows = await h.run((ctx) => ctx.db.query("consents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lawfulBasis).toBe("contract");
    expect(rows[0]!.state).toBe("granted");
    expect(rows[0]!.source).toBe("made a booking");
  });

  test("BOOKING AGAIN NEVER UNDOES A WITHDRAWAL", async () => {
    /*
     * The one thing that would make writing a consent row on somebody's behalf
     * indefensible. A customer who asked us to stop, and who later books,
     * still gets no message — and the refusal is a row in the outbox saying
     * so, not silence.
     */
    const h = harness();
    const s = await seed(h, {
      consents: [{ state: "withdrawn", at: AT(2) }],
    });

    expect(s.booking.confirmation.queued).toBe(false);
    expect(s.booking.confirmation.notice).toMatch(/asked us to stop|has not agreed/);

    const consents = await h.run((ctx) => ctx.db.query("consents").collect());
    expect(consents).toHaveLength(1);
    expect(consents[0]!.state).toBe("withdrawn");

    const rows = await messagesIn(h, "booking_confirmation");
    expect(rows[0]!.status).toBe("suppressed_consent");
  });

  test("a customer with an email is reached on the channel that can deliver", async () => {
    // Email is the only live driver, so an address is what makes a customer
    // reachable today. Without one it falls to WhatsApp, which has no provider.
    const h = harness();
    const withEmail = await seed(h, { email: "thabo@example.com" });
    const rows = await messagesIn(h, "booking_confirmation");
    expect(rows[0]!.channel).toBe("email");
    expect(rows[0]!.to).toBe("thabo@example.com");
    expect(withEmail.booking.confirmation.queued).toBe(true);
  });
});

describe("the choke point", () => {
  test("queues a message when consent is granted and it is daytime", async () => {
    const h = harness();
    const s = await seed(h);
    await grantWhatsapp(s);

    const result = await send(s);
    expect(result.outcome).toBe("queued");

    const rows = await reminders(h);
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

    expect(await reminders(h)).toHaveLength(1);
    expect(first.outcome).toBe("queued");
  });

  test("NEVER WITHOUT CONSENT — absent is not granted", async () => {
    /*
     * A customer who has never been asked has not agreed. Tested on SMS: the
     * booking establishes a basis for the ONE channel its confirmation uses
     * and touches no other, which is exactly the property being relied on
     * here.
     */
    const h = harness();
    const s = await seed(h);

    const result = await send(s, { channel: "sms" });
    expect(result.outcome).toBe("suppressed_consent");

    // A row is still written: an invisible drop is indistinguishable from a bug.
    const rows = await reminders(h);
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

  test("consent is per CHANNEL — a booking does not grant SMS", async () => {
    const h = harness();
    const s = await seed(h);
    await grantWhatsapp(s);

    const result = await send(s, { channel: "sms" });
    expect(result.outcome).toBe("suppressed_consent");
  });

  test("NOWHERE TO SEND IT is a stated reason, not a queued row", async () => {
    /*
     * `to` used to be the phone number whatever the channel was, so an email
     * message would have been handed a phone number to send mail to. Nothing
     * caught it because no driver existed to try.
     */
    const h = harness();
    const s = await seed(h);
    await s.owner.mutation(api.customers.recordConsent, {
      clientSlug: "alpha", customerId: s.customerId, channel: "email",
      state: "granted", lawfulBasis: "consent", source: "booking form",
    });

    const result = await send(s, { channel: "email" });
    expect(result.outcome).toBe("no_destination");

    const rows = await reminders(h);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toMatch(/no email address/i);
    // No provider was asked, so no attempt is claimed.
    expect(rows[0]!.attempts).toBe(0);
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

    const rows = await reminders(h);
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

    const rows = await reminders(h);
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

  test("and the booking itself says so, at the moment it is taken", async () => {
    const h = harness();
    const s = await seed(h, { isDemo: true });
    expect(s.booking.confirmation.queued).toBe(false);
    expect(s.booking.confirmation.notice).toMatch(/Demo data/);
  });
});

describe("a prospect is not a customer", () => {
  /**
   * THE HOLE THE DEMO FLAGS DO NOT COVER.
   *
   * `isDemo` and `isSeed` are designations applied to data we invented. A lead
   * carries neither, and a lead is REAL — the dev deployment holds 39 actual
   * KZN solar installers with actual numbers off trade directories. That is
   * exactly what makes messaging one the expensive version of this mistake.
   *
   * Outreach in this business is drafted and sent by hand, deliberately. A
   * transactional pipeline that can reach a prospect is an outreach channel
   * whether or not anyone meant to build one — and one that sends on a cron.
   */
  /**
   * A real one, off the real import. Inserted BEFORE `seed` in most of these,
   * because `book` queues its confirmation in the booking transaction — so a
   * lead added afterwards is a different test.
   */
  const installer = async (
    h: Harness,
    over: { phone?: string; website?: string } = {},
  ) => {
    await h.run(async (ctx) => {
      const ventureId =
        (await ctx.db.query("ventures").first())?._id ??
        (await ctx.db.insert("ventures", {
          name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
        }));
      await ctx.db.insert("leads", {
        ventureId,
        businessName: "KZN IEETR",
        niche: "solar",
        phone: over.phone ?? "+27825551234",
        phoneDisplay: "0825551234",
        website: over.website,
        area: "Durban",
        auditFaults: [],
        status: "new",
        provenance: {
          source: "campaign_list",
          capturedAt: AT(0),
          lawfulBasis: "legitimate_interest",
          detail: "ENF Solar directory listing (KZN)",
        },
      });
    });
  };

  test("A CUSTOMER CARRYING A LEAD'S NUMBER IS NEVER MESSAGED", async () => {
    const h = harness();
    const s = await seed(h);
    // The seeded customer's phone normalises to +27825551234 — the same number.
    await installer(h);
    await grantWhatsapp(s);

    const result = await send(s);
    expect(result.outcome).toBe("suppressed_lead");

    const rows = await reminders(h);
    expect(rows[0]!.status).toBe("suppressed_lead");
    // It names the business, because whoever reads this is the only person who
    // can say whether it was a mistake or a coincidence of numbers.
    expect(rows[0]!.error).toContain("KZN IEETR");
  });

  test("it beats consent — a granted consent does not make a prospect a customer", async () => {
    const h = harness();
    const s = await seed(h);
    await installer(h);
    await grantWhatsapp(s);

    // Even with an explicit grant on the channel, the answer is the same.
    await expect(send(s)).resolves.toMatchObject({ outcome: "suppressed_lead" });
  });

  test("AN EMAIL ON A LEAD'S DOMAIN IS REFUSED TOO", async () => {
    const h = harness();
    // A different phone, so only the domain can catch this one — and the
    // website as a directory actually printed it, scheme and www and all.
    await installer(h, { phone: "+27313735360", website: "https://www.kznieetr.co.za/" });
    const s = await seed(h, { email: "info@kznieetr.co.za" });

    const rows = await messagesIn(h, "booking_confirmation");
    expect(rows[0]!.status).toBe("suppressed_lead");
    expect(s.booking.confirmation.queued).toBe(false);
    expect(s.booking.confirmation.notice).toContain("KZN IEETR");
  });

  test("a subdomain of a lead's site is the same business", async () => {
    const h = harness();
    await installer(h, { phone: "+27313735360", website: "kznieetr.co.za" });
    await seed(h, { email: "info@mail.kznieetr.co.za" });

    const rows = await messagesIn(h, "booking_confirmation");
    expect(rows[0]!.status).toBe("suppressed_lead");
  });

  test("AN ORDINARY CUSTOMER IS UNAFFECTED", async () => {
    // The check has to be narrow enough to be worth keeping. A real customer
    // with a real number that belongs to no lead goes through untouched.
    const h = harness();
    await installer(h, { phone: "+27313735360", website: "kznieetr.co.za" });
    const s = await seed(h, { email: "thabo@example.com" });

    expect(s.booking.confirmation.queued).toBe(true);
    const rows = await messagesIn(h, "booking_confirmation");
    expect(rows[0]!.status).toBe("scheduled");
  });

  test("a lookalike domain is not a match", async () => {
    const h = harness();
    await installer(h, { phone: "+27313735360", website: "kznieetr.co.za" });
    const s = await seed(h, { email: "info@notkznieetr.co.za" });

    expect(s.booking.confirmation.queued).toBe(true);
  });

  test("the booking itself is still TAKEN — a refusal to message is not a refusal to book", async () => {
    /*
     * Same judgement as an unreachable phone number on a quote: refusing the
     * booking would turn a messaging limitation into lost business. The
     * booking stands, and the person who took it is told.
     */
    const h = harness();
    await installer(h);
    const s = await seed(h);

    const booking = await h.run((ctx) => ctx.db.get(s.bookingId));
    expect(booking).not.toBeNull();
    expect(s.booking.confirmation.queued).toBe(false);
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
     *
     * Written BEFORE the booking, so the booking finds a row and leaves it
     * alone — which is also the only ordering in which the tie is the newest
     * thing the customer did.
     */
    const h = harness();
    const s = await seed(h, {
      consents: [
        { state: "granted", at: AT(8) },
        { state: "withdrawn", at: AT(8) },
      ],
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
    const s = await seed(h, {
      consents: [
        { state: "withdrawn", at: AT(8) },
        { state: "granted", at: AT(8) },
      ],
    });

    const state = await s.owner.query(api.customers.consentState, {
      clientSlug: "alpha", customerId: s.customerId,
    });
    expect(state.whatsapp).toBe("withdrawn");
  });

  test("a later grant still wins when the times differ", async () => {
    // The tie-break must not become "withdrawn always wins".
    const h = harness();
    const s = await seed(h, {
      consents: [
        { state: "withdrawn", at: AT(6) },
        { state: "granted", at: AT(7) },
      ],
    });

    const state = await s.owner.query(api.customers.consentState, {
      clientSlug: "alpha", customerId: s.customerId,
    });
    expect(state.whatsapp).toBe("granted");
    await expect(send(s)).resolves.toMatchObject({ outcome: "queued" });
  });
});
