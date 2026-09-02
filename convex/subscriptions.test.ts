import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * THE MONTHLY FEE.
 *
 * These tests carry more weight than usual: going live needs a bank account
 * that does not exist yet, so nobody has run this against a real Paystack
 * account. An untested integration that LOOKS finished is worse than an
 * obviously unbuilt one, and the way that shows up here is a plausible
 * checkout link that charges nobody.
 *
 * So every refusal is tested as carefully as the success, and the
 * unconfigured default is tested first.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const SEP = Date.UTC(2026, 8, 2, 9);
const R = (rands: number) => rands * 100;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A Paystack that answers however the test says. */
function stubPaystack(reply: { status: number; body?: unknown }, key = "sk_test_abc123") {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubEnv("PAYSTACK_SECRET_KEY", key);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify(
        reply.body ?? {
          status: true,
          data: { authorization_url: "https://checkout.paystack.com/abc", reference: "cc_sub_x" },
        },
      ),
      { status: reply.status, headers: { "content-type": "application/json" } },
    );
  });
  return calls;
}

async function setUp(h: Harness, over: { planCode?: string | null; email?: string | null } = {}) {
  const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
    email: "owner@thecreativecurrent.co.za",
  });
  const owner = h.withIdentity({ subject: `${userId}|test-session` });

  const ventureId = await h.run((ctx) =>
    ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    }),
  );
  const clientId = await h.run((ctx) =>
    ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Renu Solar", slug: "renu", status: "live",
      timezone: "Africa/Johannesburg", currency: "ZAR", featureFlags: {},
      primaryContactEmail: over.email === null ? undefined : over.email ?? "sipho@renu.co.za",
      isDemo: false, isSeed: false,
    }),
  );

  await owner.mutation(api.subscriptions.setPlan, {
    ventureId,
    key: "care",
    name: "Care plan",
    amountCents: R(950),
    interval: "monthly",
    providerPlanCode: over.planCode === null ? undefined : over.planCode ?? "PLN_abc123",
  });

  return { h, owner, userId, ventureId, clientId };
}

type Seeded = Awaited<ReturnType<typeof setUp>>;

const start = (s: Seeded, over: Record<string, unknown> = {}) =>
  s.owner.action(api.subscriptions.start, { clientSlug: "renu", planKey: "care", ...over });

describe("an unconfigured deployment cannot charge anybody", () => {
  test("IT REFUSES, LOUDLY, AND LEAVES NOTHING BEHIND", async () => {
    /*
     * The same rule as a missing webhook secret and a missing messaging key.
     * A plausible-looking success here is a checkout link that goes nowhere,
     * handed to a paying client.
     */
    const s = await setUp(harness());
    vi.stubEnv("PAYSTACK_SECRET_KEY", "");

    const result = await start(s);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/not configured/i);

    // The pending row it reserved is rolled back, so a retry is not refused
    // as a duplicate.
    const rows = await s.h.run((ctx) => ctx.db.query("subscriptions").collect());
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);
  });

  test("a key that is not a Paystack key is refused before any request", async () => {
    const s = await setUp(harness());
    const calls = stubPaystack({ status: 200 }, "definitely-not-a-key");

    const result = await start(s);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("the mode is reported, so a screen showing nothing is legible", async () => {
    const s = await setUp(harness());
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_test_abc");
    expect((await s.owner.query(api.subscriptions.all, {})).mode).toBe("test");
    vi.stubEnv("PAYSTACK_SECRET_KEY", "");
    expect((await s.owner.query(api.subscriptions.all, {})).mode).toBe("unconfigured");
  });
});

describe("starting one", () => {
  test("it opens a checkout and leaves a PENDING row, not an active one", async () => {
    /*
     * Nothing is active until Paystack says so. A row we activate ourselves is
     * a second record of whether money is being collected, and the one that
     * matters is theirs.
     */
    const s = await setUp(harness());
    stubPaystack({ status: 200 });

    const result = await start(s);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.checkoutUrl).toContain("checkout.paystack.com");

    const row = (await s.h.run((ctx) => ctx.db.query("subscriptions").first()))!;
    expect(row.status).toBe("pending");
    expect(row.providerRef).toBeUndefined();
    expect(row.startReference).toMatch(/^cc_sub_/);
  });

  test("THE AMOUNT COMES FROM THE PLAN, and no amount is sent to Paystack", async () => {
    /*
     * Paystack overrides any amount with the plan's own price, so sending one
     * would put a number in the request that is not the number charged — and
     * the next person to read it would believe it.
     */
    const s = await setUp(harness());
    const calls = stubPaystack({ status: 200 });
    await start(s);

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.plan).toBe("PLN_abc123");
    expect(body.amount).toBeUndefined();
    expect(body.email).toBe("sipho@renu.co.za");

    const row = (await s.h.run((ctx) => ctx.db.query("subscriptions").first()))!;
    expect(row.amountCents).toBe(R(950));
  });

  test("our reference and our ids travel with it", async () => {
    const s = await setUp(harness());
    const calls = stubPaystack({ status: 200 });
    const result = await start(s);
    if (!result.ok) throw new Error("unreachable");

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.reference).toMatch(/^cc_sub_/);
    expect(body.metadata.clientId).toBe(s.clientId);
    expect(body.metadata.subscriptionId).toBe(result.subscriptionId);
  });

  test("A REFUSAL FROM PAYSTACK LEAVES NO PENDING ROW BEHIND", async () => {
    // Otherwise the next attempt is refused as a duplicate, and the only way
    // out is a database edit.
    const s = await setUp(harness());
    stubPaystack({ status: 400, body: { status: false, message: "Invalid plan" } });

    const result = await start(s);
    expect(result.ok).toBe(false);

    const rows = await s.h.run((ctx) => ctx.db.query("subscriptions").collect());
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);

    // And a second attempt is not blocked by the first.
    stubPaystack({ status: 200 });
    expect((await start(s)).ok).toBe(true);
  });

  test("ONE LIVE SUBSCRIPTION PER CLIENT", async () => {
    /*
     * Two checkout links in circulation, both paid, is a client billed twice
     * every month by two subscriptions neither party is watching.
     */
    const s = await setUp(harness());
    stubPaystack({ status: 200 });
    expect((await start(s)).ok).toBe(true);

    const second = await start(s);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toMatch(/already has a pending subscription/i);
    expect(await s.h.run((ctx) => ctx.db.query("subscriptions").collect())).toHaveLength(1);
  });
});

describe("what it refuses to sell", () => {
  test("DEMO AND SEED DATA IS NEVER CHARGED", async () => {
    // The path that reaches a real card. The demo regime exists so a business
    // who never signed up cannot be billed by a mistake in our code.
    const s = await setUp(harness());
    stubPaystack({ status: 200 });
    await s.h.run((ctx) => ctx.db.patch(s.clientId, { isDemo: true }));

    await expect(start(s)).rejects.toThrow(/NOT_A_REAL_CLIENT/);
    expect(await s.h.run((ctx) => ctx.db.query("subscriptions").collect())).toEqual([]);
  });

  test("a plan with no Paystack code — it would charge once and subscribe nobody", async () => {
    const s = await setUp(harness(), { planCode: null });
    stubPaystack({ status: 200 });
    await expect(start(s)).rejects.toThrow(/PLAN_NOT_AT_PROVIDER/);
  });

  test("an inactive plan", async () => {
    const s = await setUp(harness());
    stubPaystack({ status: 200 });
    await s.owner.mutation(api.subscriptions.setPlan, {
      ventureId: s.ventureId, key: "care", name: "Care plan",
      amountCents: R(950), interval: "monthly", providerPlanCode: "PLN_abc123", active: false,
    });
    await expect(start(s)).rejects.toThrow(/PLAN_INACTIVE/);
  });

  test("a client with no contact email — the receipt would go nowhere", async () => {
    const s = await setUp(harness(), { email: null });
    stubPaystack({ status: 200 });
    await expect(start(s)).rejects.toThrow(/NO_CONTACT_EMAIL/);
  });

  test("a plan belonging to another venture", async () => {
    // The same rule as income and expenses: the arithmetic still adds up and
    // every per-venture figure is quietly wrong.
    const s = await setUp(harness());
    stubPaystack({ status: 200 });
    const other = await s.h.run((ctx) =>
      ctx.db.insert("ventures", {
        name: "Systems", type: "consulting", currency: "ZAR", active: true, sortOrder: 2,
      }),
    );
    await s.h.run(async (ctx) => {
      const plan = await ctx.db.query("plans").first();
      await ctx.db.patch(plan!._id, { ventureId: other });
    });
    await expect(start(s)).rejects.toThrow(/WRONG_VENTURE/);
  });

  test("a client owner is not platform staff", async () => {
    const s = await setUp(harness());
    const tenantUser = await s.h.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "sipho@renu.co.za" });
      await ctx.db.insert("memberships", {
        userId, clientId: s.clientId, role: "owner", active: true, acceptedAt: SEP,
      });
      return userId;
    });
    await expect(
      s.h
        .withIdentity({ subject: `${tenantUser}|test-session` })
        .action(api.subscriptions.start, { clientSlug: "renu", planKey: "care" }),
    ).rejects.toThrow(/platform access/);
  });
});

describe("plans", () => {
  test("editing a plan does NOT re-price an existing subscription", async () => {
    /*
     * The subscription snapshotted its amount, exactly as an invoice
     * snapshots its issuer. A price rise applies to the next customer, not to
     * one who already agreed a number.
     */
    const s = await setUp(harness());
    stubPaystack({ status: 200 });
    await start(s);

    await s.owner.mutation(api.subscriptions.setPlan, {
      ventureId: s.ventureId, key: "care", name: "Care plan",
      amountCents: R(1_400), interval: "monthly", providerPlanCode: "PLN_abc123",
    });

    const row = (await s.h.run((ctx) => ctx.db.query("subscriptions").first()))!;
    expect(row.amountCents).toBe(R(950));
  });

  test("a plan with no provider code is listed as not sellable", async () => {
    const s = await setUp(harness(), { planCode: null });
    const [plan] = await s.owner.query(api.subscriptions.plans, {});
    expect(plan!.sellable).toBe(false);
  });

  test("a free plan is refused — that is a feature flag, not a subscription", async () => {
    const s = await setUp(harness());
    await expect(
      s.owner.mutation(api.subscriptions.setPlan, {
        ventureId: s.ventureId, key: "free", name: "Free",
        amountCents: 0, interval: "monthly",
      }),
    ).rejects.toThrow(/BAD_MONEY/);
  });
});

describe("cancelling says what it did and did not do", () => {
  test("IT DOES NOT TELL PAYSTACK, AND SAYS SO", async () => {
    /*
     * Disabling a Paystack subscription needs an email token fetched from
     * their API. Marking ours cancelled while theirs keeps billing is the
     * worst available outcome: the client still pays, our screen says they do
     * not, and nobody looks again.
     */
    const s = await setUp(harness());
    stubPaystack({ status: 200 });
    const started = await start(s);
    if (!started.ok) throw new Error("unreachable");

    await s.h.run((ctx) =>
      ctx.db.patch(started.subscriptionId as Id<"subscriptions">, {
        providerRef: "SUB_live123",
        status: "active",
      }),
    );

    const result = await s.owner.mutation(api.subscriptions.markCancelled, {
      subscriptionId: started.subscriptionId,
      now: SEP,
    });

    expect(result.notice).toContain("SUB_live123");
    expect(result.notice).toMatch(/Paystack dashboard/);
    const row = (await s.h.run((ctx) => ctx.db.query("subscriptions").first()))!;
    expect(row.status).toBe("cancelled");
  });

  test("and says the opposite when nothing was ever live there", async () => {
    const s = await setUp(harness());
    stubPaystack({ status: 200 });
    const started = await start(s);
    if (!started.ok) throw new Error("unreachable");

    const result = await s.owner.mutation(api.subscriptions.markCancelled, {
      subscriptionId: started.subscriptionId,
      now: SEP,
    });
    expect(result.notice).toMatch(/nothing to cancel there/i);
  });
});
