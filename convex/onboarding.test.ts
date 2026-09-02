import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * THE FIRST REAL CLIENT.
 *
 * This exists so the messaging pipeline can be exercised against a real
 * mailbox without turning off the guard that stops seeded data being messaged.
 * The tests below are mostly about it staying small: a setup function that
 * quietly becomes the way clients get made is how the onboarding transaction
 * stays unbuilt forever.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const SEP = Date.UTC(2026, 8, 2, 9);

/** An account has to exist first — this grants, it does not create. */
async function withOwner(h: Harness, email = "taine@example.com") {
  return h.run((ctx) => ctx.db.insert("users", { email }));
}

const create = (h: Harness, over: Record<string, unknown> = {}) =>
  h.mutation(internal.onboarding.createFirstClient, {
    name: "Renu Solar",
    slug: "renu-solar",
    ownerEmail: "taine@example.com",
    contactEmail: "bookings@renusolar.co.za",
    contactPhone: "031 373 5360",
    ...over,
  });

describe("creating it", () => {
  test("the client is NEITHER demo NOR seed — that is the whole point", async () => {
    /*
     * The alternative on offer was flipping isSeed on the seeded client, which
     * is turning off a guard to pass a test. Seeded data is refused by
     * dispatch precisely so it can never be the thing you verified against.
     */
    const h = harness();
    await withOwner(h);
    const { clientId } = await create(h);

    const client = (await h.run((ctx) => ctx.db.get(clientId as Id<"clients">)))!;
    expect(client.isDemo).toBe(false);
    expect(client.isSeed).toBe(false);
    expect(client.primaryContactEmail).toBe("bookings@renusolar.co.za");
  });

  test("it comes with the pieces a booking needs", async () => {
    const h = harness();
    await withOwner(h);
    const result = await create(h);

    const location = await h.run((ctx) => ctx.db.get(result.locationId as Id<"locations">));
    const service = await h.run((ctx) => ctx.db.get(result.serviceId as Id<"services">));
    expect(location?.active).toBe(true);
    expect(service?.active).toBe(true);

    const membership = await h.run((ctx) => ctx.db.query("memberships").first());
    expect(membership?.role).toBe("owner");
    expect(membership?.active).toBe(true);
  });

  test("the owner can actually reach the back office afterwards", async () => {
    // A membership that does not resolve is a client nobody can open.
    const h = harness();
    const userId = await withOwner(h);
    await create(h);

    const asOwner = h.withIdentity({ subject: `${userId}|test-session` });
    await expect(
      asOwner.query(api.quoteRequests.list, { clientSlug: "renu-solar" }),
    ).resolves.toEqual([]);
  });

  test("IT DISARMS ITSELF once a real client exists", async () => {
    /*
     * Same shape as bootstrap:claimPlatformOwner. A convenient back door is
     * how the onboarding transaction stays unbuilt.
     */
    const h = harness();
    await withOwner(h);
    await create(h);

    await expect(create(h, { slug: "another-one" })).rejects.toThrow(/ALREADY_ONBOARDED/);
  });

  test("a SEEDED client does not count as onboarded", async () => {
    // Otherwise running the demo seed first would lock this out entirely.
    const h = harness();
    await withOwner(h);
    await h.mutation(internal.seed.solarClient, {});

    await expect(create(h, { slug: "renu-solar-live" })).resolves.toMatchObject({
      slug: "renu-solar-live",
    });
  });

  test("it will not create an account, only grant to one", async () => {
    const h = harness();
    await expect(create(h)).rejects.toThrow(/NO_SUCH_USER/);
    expect(await h.run((ctx) => ctx.db.query("clients").collect())).toEqual([]);
  });

  test("a blank contact email is refused — it is what makes replies work", async () => {
    const h = harness();
    await withOwner(h);
    await expect(create(h, { contactEmail: "   " })).rejects.toThrow(/cannot be blank/);
  });

  test("it does NOT write a site — siteConfigs is the only writer of that table", async () => {
    const h = harness();
    await withOwner(h);
    await create(h);
    expect(await h.run((ctx) => ctx.db.query("sites").collect())).toEqual([]);
  });
});

describe("taking the first booking", () => {
  const book = (h: Harness, over: Record<string, unknown> = {}) =>
    h.mutation(internal.onboarding.takeFirstBooking, {
      clientSlug: "renu-solar",
      customerName: "Thabo M",
      customerPhone: "0825551234",
      customerEmail: "taine@example.com",
      startsAt: SEP,
      ...over,
    });

  const setUp = async (h: Harness) => {
    await withOwner(h);
    return create(h);
  };

  test("it queues a confirmation, through the real booking path", async () => {
    const h = harness();
    await setUp(h);

    const result = await book(h);
    expect(result.confirmation.queued).toBe(true);

    const rows = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("email");
    expect(rows[0]!.to).toBe("taine@example.com");
    /*
     * Scheduled OR held: this books against the REAL clock, and quiet hours
     * are a fact about the wall time the suite runs at. Asserting "scheduled"
     * passes all day and fails after 20:00 local, which is the worst kind of
     * test — green on every machine that runs it in working hours.
     */
    expect(["scheduled", "holding_quiet_hours"]).toContain(rows[0]!.status);
  });

  test("THE OVERLAP CHECK STILL APPLIES — it is the same function `book` calls", async () => {
    /*
     * The reason this goes through createBooking rather than inserting a
     * booking of its own. A setup path that skips the rules is a setup path
     * that verifies nothing about the real one.
     */
    const h = harness();
    await setUp(h);
    await book(h);

    await expect(book(h, { customerPhone: "0825559999" })).rejects.toThrow(/SLOT_TAKEN/);
  });

  test("and so does the consent the booking establishes", async () => {
    const h = harness();
    await setUp(h);
    await book(h);

    const consent = await h.run((ctx) => ctx.db.query("consents").first());
    expect(consent?.lawfulBasis).toBe("contract");
    expect(consent?.channel).toBe("email");
  });

  test("the phone is stored E.164, not raw", async () => {
    // One normaliser. A raw string here is a second opinion about the
    // suppression key — see lib/phone.ts.
    const h = harness();
    await setUp(h);
    const { customerId } = await book(h);

    const customer = (await h.run((ctx) => ctx.db.get(customerId as Id<"customers">)))!;
    expect(customer.phone).toBe("+27825551234");
  });

  test("booking the same customer twice reuses the record", async () => {
    const h = harness();
    await setUp(h);
    await book(h);
    await book(h, { startsAt: SEP + 3 * 60 * 60 * 1000 });

    expect(await h.run((ctx) => ctx.db.query("customers").collect())).toHaveLength(1);
  });

  test("an unknown slug is refused rather than guessed at", async () => {
    const h = harness();
    await setUp(h);
    await expect(book(h, { clientSlug: "not-a-client" })).rejects.toThrow(/NOT_FOUND/);
  });
});
