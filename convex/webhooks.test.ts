import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * PROVIDER WEBHOOKS.
 *
 * The messaging idempotency problem with money attached. Every failure here
 * is silent — the endpoint returns 200 whether it did the right thing or
 * credited a stranger — so the tests are about the three things the provider
 * guarantees will happen: retries, duplicates, and delivery out of order.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const PAYSTACK_SECRET = "sk_test_pretend_secret";
const PADDLE_SECRET = "pdl_ntfset_pretend_secret";

beforeEach(() => {
  process.env.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET;
  process.env.PADDLE_WEBHOOK_SECRET = PADDLE_SECRET;
});

const enc = new TextEncoder();

async function sign(algorithm: "SHA-256" | "SHA-512", secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const paystackPost = async (h: Harness, body: unknown, overrideSignature?: string) => {
  const raw = JSON.stringify(body);
  return h.fetch("/webhooks/paystack", {
    method: "POST",
    body: raw,
    headers: { "x-paystack-signature": overrideSignature ?? (await sign("SHA-512", PAYSTACK_SECRET, raw)) },
  });
};

const paddlePost = async (h: Harness, body: unknown, atSeconds = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify(body);
  const h1 = await sign("SHA-256", PADDLE_SECRET, `${atSeconds}:${raw}`);
  return h.fetch("/webhooks/paddle", {
    method: "POST",
    body: raw,
    headers: { "paddle-signature": `ts=${atSeconds};h1=${h1}` },
  });
};

/** A client with a live subscription the provider can refer to. */
async function setup(over: { isDemo?: boolean } = {}) {
  const h = harness();
  const ids = await h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites",
      type: "platform",
      currency: "ZAR",
      active: true,
      sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId,
      kind: "platform",
      name: "Alpha",
      slug: "alpha",
      status: "live",
      timezone: "Africa/Johannesburg",
      currency: "ZAR",
      featureFlags: {},
      isDemo: over.isDemo ?? false,
      isSeed: false,
    });
    const subscriptionId = await ctx.db.insert("subscriptions", {
      ventureId,
      clientId,
      plan: "care-plan",
      amountCents: 95000,
      currency: "ZAR",
      provider: "paystack",
      providerRef: "SUB_alpha_001",
      status: "active",
    });
    return { ventureId, clientId, subscriptionId };
  });
  return { h, ...ids };
}

const AUG = Date.parse("2026-08-01T10:00:00.000Z");
const SEP = Date.parse("2026-09-01T10:00:00.000Z");

const charge = (at: string, over: Record<string, unknown> = {}) => ({
  event: "charge.success",
  id: `evt_charge_${at}`,
  data: {
    id: 7001,
    reference: `ref_${at}`,
    subscription_code: "SUB_alpha_001",
    amount: 95000,
    currency: "ZAR",
    paid_at: at,
    ...over,
  },
});

const disable = (at: string) => ({
  event: "subscription.disable",
  id: `evt_disable_${at}`,
  created_at: at,
  data: { subscription_code: "SUB_alpha_001" },
});

const ledgerOf = (h: Harness) => h.run((ctx) => ctx.db.query("ledgerEntries").collect());
const paymentsOf = (h: Harness) => h.run((ctx) => ctx.db.query("payments").collect());
const eventsOf = (h: Harness) => h.run((ctx) => ctx.db.query("webhookEvents").collect());
const subOf = (h: Harness, id: Id<"subscriptions">) => h.run((ctx) => ctx.db.get(id));

describe("nothing happens before the signature is verified", () => {
  test("a correctly signed body is accepted", async () => {
    const s = await setup();
    const res = await paystackPost(s.h, charge("2026-08-01T10:00:00.000Z"));
    expect(res.status).toBe(200);
    expect(await paymentsOf(s.h)).toHaveLength(1);
  });

  test("a tampered body is rejected and touches nothing", async () => {
    /*
     * The attack this stops: intercept a real webhook, change the amount,
     * replay it. The signature is over the exact bytes, so any edit breaks it.
     */
    const s = await setup();
    const honest = charge("2026-08-01T10:00:00.000Z");
    const signature = await sign("SHA-512", PAYSTACK_SECRET, JSON.stringify(honest));

    const tampered = charge("2026-08-01T10:00:00.000Z", { amount: 9500000 });
    const res = await paystackPost(s.h, tampered, signature);

    expect(res.status).toBe(401);
    expect(await paymentsOf(s.h)).toEqual([]);
    expect(await ledgerOf(s.h)).toEqual([]);
    // Not even recorded as an event: an unverified body is not evidence of
    // anything, and writing it would let a stranger fill the table.
    expect(await eventsOf(s.h)).toEqual([]);
  });

  test("a missing signature header is rejected", async () => {
    const s = await setup();
    const res = await s.h.fetch("/webhooks/paystack", {
      method: "POST",
      body: JSON.stringify(charge("2026-08-01T10:00:00.000Z")),
    });
    expect(res.status).toBe(401);
  });

  test("an UNCONFIGURED secret refuses with a 500 — it never accepts", async () => {
    /*
     * The most dangerous shape this codebase could have taken: treating a
     * missing secret as "verification not set up yet" and returning 200. That
     * turns a fresh deployment into one that accepts forged payments from
     * anyone who finds the URL, silently.
     *
     * 500 rather than 401 on purpose: this is our misconfiguration, and a 500
     * keeps the provider retrying until it is fixed, where a 401 can make it
     * give up on events that were perfectly real.
     */
    const s = await setup();
    delete process.env.PAYSTACK_SECRET_KEY;

    const res = await paystackPost(s.h, charge("2026-08-01T10:00:00.000Z"), "deadbeef");

    expect(res.status).toBe(500);
    expect(await paymentsOf(s.h)).toEqual([]);
    expect(await ledgerOf(s.h)).toEqual([]);
  });

  test("paddle: a signature from outside the replay window is rejected", async () => {
    // Without this, one captured signature stays valid forever and every
    // resend of a charge.success is another payment attempt.
    const s = await setup();
    const longAgo = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
    const res = await paddlePost(
      s.h,
      { event_type: "transaction.completed", event_id: "evt_1", occurred_at: "2026-08-01T10:00:00.000Z", data: {} },
      longAgo,
    );
    expect(res.status).toBe(401);
  });

  test("paddle: a current, correctly signed body is accepted", async () => {
    const s = await setup();
    const res = await paddlePost(s.h, {
      event_type: "transaction.completed",
      event_id: "evt_paddle_1",
      occurred_at: "2026-08-01T10:00:00.000Z",
      data: { subscription_id: "SUB_alpha_001", amount: "95000", currency_code: "zar" },
    });
    expect(res.status).toBe(200);
    const payments = await paymentsOf(s.h);
    expect(payments).toHaveLength(1);
    expect(payments[0]?.currency).toBe("ZAR");
  });
});

describe("the same event twice does nothing twice", () => {
  test("a redelivered charge does not take the money again", async () => {
    // Providers retry until they get a 200, and sometimes after they get one.
    const s = await setup();
    const body = charge("2026-08-01T10:00:00.000Z");

    const first = await paystackPost(s.h, body);
    const second = await paystackPost(s.h, body);

    expect(await first.json()).toMatchObject({ status: "applied" });
    expect(await second.json()).toMatchObject({ status: "duplicate" });

    expect(await paymentsOf(s.h)).toHaveLength(1);
    expect(await ledgerOf(s.h)).toHaveLength(1);
  });

  test("a duplicate still answers 200, so the provider stops retrying", async () => {
    const s = await setup();
    const body = charge("2026-08-01T10:00:00.000Z");
    await paystackPost(s.h, body);
    const second = await paystackPost(s.h, body);
    // A non-200 here would make the provider retry a duplicate we have
    // already correctly ignored, forever.
    expect(second.status).toBe(200);
  });

  test("idempotency keys on the PROVIDER's id, not on the contents", async () => {
    /*
     * Two genuinely separate charges of the same amount, a minute apart, are
     * two payments. Only the provider knows they are distinct, which is why
     * the key is its id and never a hash of what the payload says.
     */
    const s = await setup();
    await paystackPost(s.h, {
      ...charge("2026-08-01T10:00:00.000Z"),
      id: "evt_first",
    });
    await paystackPost(s.h, {
      ...charge("2026-08-01T10:00:00.000Z"),
      id: "evt_second",
    });
    expect(await paymentsOf(s.h)).toHaveLength(2);
  });
});

describe("order of arrival decides nothing", () => {
  test("charge.success AFTER subscription.disable: money kept, cancellation kept", async () => {
    /*
     * THE CASE. The August payment is real and has to land in the ledger; the
     * September cancellation is newer and has to stand. Handling these as one
     * ordered stream either loses the payment or resurrects the subscription,
     * and both look fine until someone reconciles a bank statement.
     */
    const s = await setup();

    await paystackPost(s.h, disable("2026-09-01T10:00:00.000Z"));
    const late = await paystackPost(s.h, charge("2026-08-01T10:00:00.000Z"));

    expect(late.status).toBe(200);

    // The FACT was appended: the money did arrive.
    const payments = await paymentsOf(s.h);
    expect(payments).toHaveLength(1);
    expect(payments[0]?.amountCents).toBe(95000);
    expect(await ledgerOf(s.h)).toHaveLength(1);

    // The STATE was not rolled back.
    expect((await subOf(s.h, s.subscriptionId))?.status).toBe("cancelled");
  });

  test("a stale STATE event is recorded as superseded, not silently dropped", async () => {
    const s = await setup();
    await paystackPost(s.h, disable("2026-09-01T10:00:00.000Z"));
    await paystackPost(s.h, {
      event: "subscription.create",
      id: "evt_create_late",
      created_at: "2026-08-01T10:00:00.000Z",
      data: { subscription_code: "SUB_alpha_001" },
    });

    expect((await subOf(s.h, s.subscriptionId))?.status).toBe("cancelled");
    const superseded = (await eventsOf(s.h)).find((row) => row.status === "superseded");
    // Recorded with a reason: an event nobody can find later is
    // indistinguishable from an endpoint that was never called.
    expect(superseded?.note).toMatch(/older than/);
  });

  test("the payment lands in the month it happened, not the month it arrived", async () => {
    // Arrival time would put a retried August payment into September, and a
    // month that has been reported on is supposed to stay closed.
    const s = await setup();
    await paystackPost(s.h, charge("2026-08-01T10:00:00.000Z"));
    const [entry] = await ledgerOf(s.h);
    expect(entry?.occurredAt).toBe(AUG);
    expect(entry?.occurredAt).toBeLessThan(SEP);
  });

  test("a newer state event still applies normally", async () => {
    // The ordering rule must not become "nothing ever changes".
    const s = await setup();
    await paystackPost(s.h, {
      event: "subscription.create",
      id: "evt_create",
      created_at: "2026-08-01T10:00:00.000Z",
      data: { subscription_code: "SUB_alpha_001" },
    });
    await paystackPost(s.h, disable("2026-09-01T10:00:00.000Z"));
    expect((await subOf(s.h, s.subscriptionId))?.status).toBe("cancelled");
  });

  test("a failed charge does NOT cancel — suspension stays explicit", async () => {
    // A card declining once is not a decision to stop being a customer.
    const s = await setup();
    await paystackPost(s.h, {
      event: "invoice.payment_failed",
      id: "evt_failed",
      created_at: "2026-09-01T10:00:00.000Z",
      data: { subscription_code: "SUB_alpha_001" },
    });
    const sub = await subOf(s.h, s.subscriptionId);
    expect(sub?.status).toBe("past_due");
    expect(sub?.suspendedAt).toBeUndefined();
  });
});

describe("what cannot be attributed is parked, never guessed", () => {
  test("a charge for an unknown subscription moves no money", async () => {
    /*
     * The ordinary out-of-order case: charge.success beating the
     * subscription.create that would have said whose it is. Crediting the
     * wrong client is not recoverable; a row waiting for a human is.
     */
    const s = await setup();
    await paystackPost(s.h, {
      ...charge("2026-08-01T10:00:00.000Z"),
      id: "evt_orphan",
      data: { ...charge("2026-08-01T10:00:00.000Z").data, subscription_code: "SUB_unknown" },
    });

    expect(await paymentsOf(s.h)).toEqual([]);
    expect(await ledgerOf(s.h)).toEqual([]);

    const [event] = await eventsOf(s.h);
    expect(event?.status).toBe("unattributed");
    expect(event?.note).toMatch(/SUB_unknown/);
  });

  test("an unhandled event type is recorded rather than dropped", async () => {
    const s = await setup();
    await paystackPost(s.h, {
      event: "customer.identification.failed",
      id: "evt_unhandled",
      created_at: "2026-08-01T10:00:00.000Z",
      data: {},
    });
    const [event] = await eventsOf(s.h);
    expect(event?.status).toBe("ignored");
  });

  test("a demo client cannot be charged, even by a correctly signed webhook", async () => {
    // The ledger's own rule, reached through the path most likely to test it:
    // an amount decided by somebody else entirely.
    const s = await setup({ isDemo: true });
    const res = await paystackPost(s.h, charge("2026-08-01T10:00:00.000Z"));

    /*
     * 200 with the money refused and the event PARKED, rather than a 500.
     *
     * A 500 would be defensible for one delivery and wrong by the tenth: the
     * refusal is permanent — this client will still be demo data tomorrow —
     * so retrying can only ever fail again, and the provider eventually gives
     * up. The anomaly would then exist solely in Paystack's failed-delivery
     * dashboard, which nobody reads. Parked, it is a row a human can find.
     */
    expect(res.status).toBe(200);
    expect(await ledgerOf(s.h)).toEqual([]);
    expect(await paymentsOf(s.h)).toEqual([]);

    const [event] = await eventsOf(s.h);
    expect(event?.status).toBe("refused");
    expect(event?.note).toMatch(/NOT_A_REAL_CLIENT/);
  });
});

describe("the ledger sees webhook money like any other", () => {
  test("a webhook payment shows up in the venture's revenue", async () => {
    const s = await setup();
    await paystackPost(s.h, charge("2026-08-01T10:00:00.000Z"));

    const { userId } = await s.h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    const owner = s.h.withIdentity({ subject: `${userId}|test-session` });
    const summary = await owner.query(api.income.summary, { ventureId: s.ventureId });

    expect(summary.find((row) => row.currency === "ZAR")?.totalCents).toBe(95000);
  });
});
