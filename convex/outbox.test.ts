import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * THE DRAIN.
 *
 * dispatch decides whether a message may be sent; this is what happens after
 * it says yes. Every test here is about the gap between "we decided to send"
 * and "somebody received it" — the gap where a message can be lost silently,
 * sent twice, or reported as delivered when nothing left the building.
 *
 * The last of those is the one worth the most attention. A pipeline that marks
 * things `sent` without sending them looks perfect from every screen we have.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

/** 2026-09-15 in UTC. Johannesburg is UTC+2 all year. */
const AT = (hourUtc: number, dayOffset = 0) => Date.UTC(2026, 8, 15 + dayOffset, hourUtc);
const JHB = "Africa/Johannesburg";
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function seed(h: Harness, over: { email?: string } = {}) {
  const ids = await h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Renu Solar", slug: "alpha", status: "live",
      timezone: JHB, currency: "ZAR", featureFlags: {}, isDemo: false, isSeed: false,
    });
    const locationId = await ctx.db.insert("locations", {
      clientId, name: "Hillcrest", addressLine: "12 Old Main Rd", suburb: "Hillcrest",
      city: "Durban", region: "KwaZulu-Natal", countryCode: "ZA", timezone: JHB, active: true,
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
  const { serviceId } = await owner.mutation(api.services.create, {
    clientSlug: "alpha", key: "assessment", name: "Assessment",
    durationMinutes: 60, priceCents: 95000,
  });

  return { ...ids, owner, customerId, serviceId };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const bookAt = (s: Seeded, startsAt: number) =>
  s.owner.mutation(api.bookings.book, {
    clientSlug: "alpha",
    locationId: s.locationId,
    serviceId: s.serviceId,
    customerId: s.customerId,
    startsAt,
  });

const messages = (h: Harness): Promise<Doc<"messages">[]> =>
  h.run((ctx) => ctx.db.query("messages").collect());

const only = async (h: Harness): Promise<Doc<"messages">> => {
  const rows = await messages(h);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

/**
 * A Resend that answers however the test says.
 *
 * The allowlist is opened unless a test says otherwise. It defaults to sending
 * NOBODY, so leaving it out of this helper would make every send test a test
 * of the allowlist — which is a real test, and it has its own describe block
 * below rather than being smeared across all of them.
 */
function stubResend(reply: { status: number; body?: unknown }, allowlist = "*") {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubEnv("MESSAGING_ALLOWLIST", allowlist);
  vi.stubEnv("MESSAGING_RESEND_KEY", "re_test_key");
  vi.stubEnv("MESSAGING_EMAIL_FROM", "The Creative Current <hello@example.test>");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply.body ?? { id: "resend-1" }), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

describe("a channel with no provider is not a channel that sends", () => {
  test("WHATSAPP IS RECORDED AS NOT SENT, WITH THE REASON, NOT AS DELIVERED", async () => {
    /*
     * The whole reason the no-op driver refuses instead of returning success.
     * A no-op that reported delivery would stamp `sent` on a row nobody
     * received, and the outbox — the one screen that answers "did they hear
     * from us" — would answer yes.
     */
    const h = harness();
    const s = await seed(h); // no email, so the confirmation goes to WhatsApp
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });

    const row = await only(h);
    expect(row.channel).toBe("whatsapp");
    expect(row.status).toBe("failed");
    expect(row.sentAt).toBeUndefined();
    expect(row.providerName).toBe("whatsapp-noop");
    expect(row.error).toMatch(/No WhatsApp provider is configured/);
  });

  test("and it does not burn five attempts getting there", async () => {
    // Nothing about waiting makes a provider account exist.
    const h = harness();
    const s = await seed(h);
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });
    expect((await only(h)).attempts).toBe(1);
  });
});

describe("email goes out for real", () => {
  test("a delivered message is marked sent, with the provider's own id", async () => {
    const h = harness();
    const calls = stubResend({ status: 200, body: { id: "resend-abc" } });
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    const result = await h.action(internal.outbox.drain, { now: AT(8) });
    expect(result).toEqual({ attempted: 1, delivered: 1 });

    const row = await only(h);
    expect(row.status).toBe("sent");
    expect(row.sentAt).toBe(AT(8));
    expect(row.providerName).toBe("resend");
    expect(row.providerMessageId).toBe("resend-abc");
    expect(row.error).toBeUndefined();

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.to).toEqual(["thabo@example.com"]);
    // The BUSINESS is the sender a customer sees, not the platform.
    expect(body.from).toContain("The Creative Current");
    expect(body.subject).toContain("Booking confirmed");
    expect(body.text).toContain("Renu Solar");
  });

  test("A CLAIMED MESSAGE IS SENT ONCE, however often the drain runs", async () => {
    const h = harness();
    const calls = stubResend({ status: 200 });
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });
    await h.action(internal.outbox.drain, { now: AT(8) });
    await h.action(internal.outbox.drain, { now: AT(8) });

    expect(calls).toHaveLength(1);
    expect((await only(h)).status).toBe("sent");
  });

  test("a 5xx is retried on a backoff, not given up on", async () => {
    const h = harness();
    stubResend({ status: 502, body: { message: "bad gateway" } });
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });

    const row = await only(h);
    expect(row.status).toBe("scheduled");
    expect(row.attempts).toBe(1);
    expect(row.scheduledFor).toBeGreaterThan(AT(8));
    // The reason is kept while it retries, so the outbox can say what went
    // wrong on the attempt before rather than only after the last one.
    expect(row.error).toMatch(/502/);
  });

  test("A BAD ADDRESS FAILS AT ONCE — retrying reproduces it exactly", async () => {
    const h = harness();
    stubResend({ status: 422, body: { message: "invalid to field" } });
    const s = await seed(h, { email: "not-an-address" });
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });

    const row = await only(h);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/422/);
  });

  test("it gives up eventually, so a stuck row reads as stuck", async () => {
    /*
     * A row retrying forever is indistinguishable, in the outbox, from one
     * still waiting its turn — so the thing a person needs to see (this is not
     * going to happen, look at it) never surfaces.
     */
    const h = harness();
    stubResend({ status: 500 });
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    let now = AT(8);
    for (let pass = 0; pass < 6; pass += 1) {
      await h.action(internal.outbox.drain, { now });
      const row = await only(h);
      if (row.status === "failed") break;
      // Jump to whenever it asked to be tried again.
      now = row.scheduledFor;
    }

    const row = await only(h);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(5);
    expect(row.error).toMatch(/Gave up after 5 attempts/);
  });

  test("an unconfigured deployment refuses loudly rather than skipping", async () => {
    // Same reasoning as a missing webhook secret: an unconfigured deployment
    // must fail visibly and keep asking, never decide the message was handled.
    const h = harness();
    vi.stubEnv("MESSAGING_ALLOWLIST", "*");
    vi.stubEnv("MESSAGING_RESEND_KEY", "");
    vi.stubEnv("MESSAGING_EMAIL_FROM", "");
    vi.stubEnv("AUTH_RESEND_KEY", "");
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });

    const row = await only(h);
    expect(row.status).toBe("scheduled"); // retrying, not silently dropped
    expect(row.error).toMatch(/No email provider configured/);
  });
});

describe("the send allowlist", () => {
  /**
   * A live driver plus a database of real people is something that can reach
   * them before anybody has read one message it produced. The allowlist is the
   * dial between wired-up and loose.
   *
   * It gates at the DRIVER, not at dispatch, so a held message is still
   * queued, still claimed, still counted and still in the outbox with the
   * reason. Refusing at queue time would hide the very rows it was turned on
   * to look at.
   */
  test("NOTHING SENDS WHEN THE ALLOWLIST IS UNSET", async () => {
    /*
     * The deliberate inversion of "prefer sending twice over suppressing".
     * The deployment this protects is the one nobody configures — dev, which
     * holds real leads and real numbers and never gets a go-live checklist.
     * Defaulting open would protect the deployment already being watched and
     * leave the dangerous one open.
     */
    const h = harness();
    const calls = stubResend({ status: 200 }, "");
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });

    expect(calls).toHaveLength(0);
    const row = await only(h);
    expect(row.status).toBe("failed");
    // Loud, not silent: the row names the variable and the value that opens it.
    expect(row.error).toMatch(/MESSAGING_ALLOWLIST is not set/);
    expect(row.error).toContain('"*"');
  });

  test("an address on the list sends; one beside it does not", async () => {
    const h = harness();
    const calls = stubResend({ status: 200 }, "taine@thecreativecurrent.co.za");

    const mine = await seed(h, { email: "taine@thecreativecurrent.co.za" });
    await bookAt(mine, AT(9, 1));
    await h.action(internal.outbox.drain, { now: AT(8) });
    expect(calls).toHaveLength(1);

    const rows = await messages(h);
    expect(rows[0]!.status).toBe("sent");
  });

  test("A REAL CUSTOMER IS HELD, VISIBLY, WITH THE PROVIDER NAMED", async () => {
    const h = harness();
    const calls = stubResend({ status: 200 }, "taine@thecreativecurrent.co.za");
    const s = await seed(h, { email: "someone.else@example.com" });
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });

    expect(calls).toHaveLength(0);
    const row = await only(h);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/not on this deployment's MESSAGING_ALLOWLIST/);
    // The provider that WOULD have handled it, so the outbox still reads right.
    expect(row.providerName).toBe("resend");
    // One attempt, not five: waiting does not put an address on a list.
    expect(row.attempts).toBe(1);
  });

  test("a leading @ allows a whole domain", async () => {
    const h = harness();
    const calls = stubResend({ status: 200 }, "@thecreativecurrent.co.za");
    const s = await seed(h, { email: "Taine@TheCreativeCurrent.co.za" });
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });
    expect(calls).toHaveLength(1);
    expect((await only(h)).status).toBe("sent");
  });

  test("a domain entry does not allow a lookalike", async () => {
    // @thecreativecurrent.co.za must not match evil-thecreativecurrent.co.za.
    const h = harness();
    const calls = stubResend({ status: 200 }, "@thecreativecurrent.co.za");
    const s = await seed(h, { email: "taine@evil-thecreativecurrent.co.za" });
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });
    expect(calls).toHaveLength(0);
  });

  test("the allowlist does not turn a no-op channel into a mystery", async () => {
    // "Not on the allowlist" would be true and unhelpful for WhatsApp: the
    // reason nothing sends there is that no provider exists.
    const h = harness();
    stubResend({ status: 200 }, "");
    const s = await seed(h); // no email — falls to WhatsApp
    await bookAt(s, AT(9, 1));

    await h.action(internal.outbox.drain, { now: AT(8) });
    expect((await only(h)).error).toMatch(/No WhatsApp provider is configured/);
  });
});

describe("quiet hours are re-checked when the message is picked up", () => {
  test("a row written at 19:58 does not go out at 20:01", async () => {
    /*
     * dispatch checks quiet hours when the row is written. The customer whose
     * phone lights up at 22:00 does not care which side of the boundary the
     * WRITE happened on.
     */
    const h = harness();
    stubResend({ status: 200 });
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    // 20:00 UTC is 22:00 in Johannesburg.
    await h.action(internal.outbox.drain, { now: AT(20) });

    const row = await only(h);
    expect(row.status).toBe("holding_quiet_hours");
    expect(row.scheduledFor).toBeGreaterThan(AT(20));
    expect(row.attempts).toBe(0); // held, so no attempt was made
  });
});

describe("a send that never came back", () => {
  test("A STRANDED ROW IS REQUEUED, ACCEPTING A DUPLICATE OVER SILENCE", async () => {
    /*
     * The drain claims in one mutation, calls the provider from an action, and
     * records in a second. If the action dies in between, the row sits in
     * `sending` and nothing will ever look at it again. This codebase prefers
     * sending twice over suppressing, so after the timeout it goes back in the
     * queue — and the row says so, in case the customer got two.
     */
    const h = harness();
    const calls = stubResend({ status: 200 });
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    // Claim it and then vanish, exactly as a dying action would.
    const rows = await messages(h);
    await h.mutation(internal.outbox.claim, { messageId: rows[0]!._id, now: AT(8) });
    expect((await only(h)).status).toBe("sending");

    // Too soon: still assumed to be in flight.
    await h.action(internal.outbox.drain, { now: AT(8) + 60_000 });
    expect((await only(h)).status).toBe("sending");
    expect(calls).toHaveLength(0);

    // Past the timeout: requeued, and the next pass sends it.
    await h.action(internal.outbox.drain, { now: AT(8) + 20 * 60_000 });
    const row = await only(h);
    expect(row.status).toBe("sent");
    expect(calls).toHaveLength(1);
  });
});

describe("reminders are swept from current state, never scheduled ahead", () => {
  const sweep = (h: Harness, hoursBefore: 24 | 1, now: number) =>
    h.mutation(internal.outbox.queueDueReminders, {
      hoursBefore,
      windowMs: 15 * 60_000,
      now,
    });

  test("a booking about 24 hours out gets its reminder", async () => {
    const h = harness();
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    const result = await sweep(h, 24, AT(9, 1) - 24 * HOUR);
    expect(result.queued).toBe(1);

    const reminder = (await messages(h)).find((m) => m.templateKey === "reminder_24h");
    expect(reminder).toBeDefined();
    expect(reminder!.channel).toBe("email");
  });

  test("SWEEPING TWICE DOES NOT REMIND TWICE", async () => {
    // Overlapping windows are what make a missed cron run recoverable. They
    // are only free because the idempotency key refuses the second.
    const h = harness();
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    const at = AT(9, 1) - 24 * HOUR;
    await sweep(h, 24, at);
    const second = await sweep(h, 24, at + 60_000);
    expect(second.queued).toBe(0);

    const reminders = (await messages(h)).filter((m) => m.templateKey === "reminder_24h");
    expect(reminders).toHaveLength(1);
  });

  test("A CANCELLED BOOKING IS NOT REMINDED ABOUT", async () => {
    /*
     * The reason reminders are swept rather than scheduled at booking time. A
     * job scheduled for `startsAt - 24h` still exists after the booking is
     * cancelled; a sweep of current state simply does not find it.
     */
    const h = harness();
    const s = await seed(h, { email: "thabo@example.com" });
    const { bookingId } = await bookAt(s, AT(9, 1));
    await s.owner.mutation(api.bookings.setStatus, {
      clientSlug: "alpha", bookingId, status: "cancelled",
    });

    const result = await sweep(h, 24, AT(9, 1) - 24 * HOUR);
    expect(result.queued).toBe(0);
    expect((await messages(h)).some((m) => m.templateKey === "reminder_24h")).toBe(false);
  });

  test("A RESCHEDULED BOOKING IS FOUND AT ITS NEW TIME, NOT ITS OLD ONE", async () => {
    /*
     * The other reason. A Friday booking pushed to Monday would, with a job
     * scheduled at booking time, get its "tomorrow" reminder on Thursday.
     */
    const h = harness();
    const s = await seed(h, { email: "thabo@example.com" });
    const { bookingId } = await bookAt(s, AT(9, 1));

    // Move it three days out, the way a reschedule would.
    const moved = AT(9, 4);
    await h.run((ctx) => ctx.db.patch(bookingId, { startsAt: moved, endsAt: moved + HOUR }));

    // The old moment finds nothing...
    expect((await sweep(h, 24, AT(9, 1) - 24 * HOUR)).queued).toBe(0);
    // ...and the new one finds it.
    expect((await sweep(h, 24, moved - 24 * HOUR)).queued).toBe(1);
  });

  test("the 1-hour sweep is a different message from the 24-hour one", async () => {
    const h = harness();
    const s = await seed(h, { email: "thabo@example.com" });
    await bookAt(s, AT(9, 1));

    await sweep(h, 24, AT(9, 1) - 24 * HOUR);
    await sweep(h, 1, AT(9, 1) - HOUR);

    const keys = (await messages(h)).map((m) => m.templateKey).sort();
    expect(keys).toEqual(["booking_confirmation", "reminder_1h", "reminder_24h"]);
  });
});
