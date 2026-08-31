import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { byDesc, byAsc, byName, byOrderThenName } from "./lib/ordering";

/**
 * ORDER THAT DOES NOT DRIFT.
 *
 * The consent bug passed locally and failed in CI: identical code, a different
 * database scan order, the opposite answer. This file is the sweep that
 * followed, over every read that sorts by a key two rows can share.
 *
 * The sweep found two different problems wearing the same clothes, and the
 * tests are shaped differently because the problems are:
 *
 *   A TIE THAT DECIDES A FACT. "Which branch is this job at." There is a right
 *   answer or there is none, and the reversed-insertion test is exactly right
 *   because the answer must not depend on write order. `accept` had one of
 *   these and it is fixed below by refusing the question.
 *
 *   A TIE THAT ONLY ORDERS A LIST. A statement, an outbox. Here there is no
 *   right answer to find — the rows are tied — and the requirement is only
 *   that the order cannot move between two reads. See the note above
 *   `assertTotallyOrdered` for why demanding more than that would be a bug in
 *   the test rather than a stronger test.
 *
 * A caution about what the integration blocks prove. convex-test runs an
 * in-memory database whose scan order is its own, not production's, so a pass
 * is evidence the comparator is total rather than evidence about the real
 * backend. That is the right thing to prove: a total comparator makes the
 * backend's order irrelevant, which is the actual fix. The unit block is
 * therefore the load-bearing one, and the integration blocks exist to catch a
 * reader that quietly stops using it.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

const JHB = "Africa/Johannesburg";

/**
 * WHY THE REVERSED-INSERTION SHAPE DOES NOT TRANSFER HERE.
 *
 * For consent it was exactly right: "which row is current" has an answer in
 * the data, so the same rows written either way MUST resolve the same. A test
 * that reversed the writes proved the answer was not coming from write order.
 *
 * Display order is a different question. Three entries genuinely tied on the
 * sort key have NO answer in the data about which comes first — that is what
 * makes them tied. Demanding that two separately-built databases agree would
 * demand an answer that does not exist, and the only way to pass would be to
 * invent one (sort by description? by amount?) and present it to the owner as
 * meaningful.
 *
 * The real requirement is narrower and is the actual bug: within ONE database,
 * the order must not change between reads. A total comparator gives that, and
 * this is how you check for one — the output is fully determined by (key, _id),
 * so no permutation of the input can produce a different result. Drop the
 * tie-break and this fails; keep it and the order cannot drift on refresh.
 */
function assertTotallyOrdered<T extends { _id: string }>(
  rows: readonly T[],
  key: (row: T) => number,
  direction: "desc" | "asc" = "desc",
) {
  for (let i = 1; i < rows.length; i++) {
    const before = rows[i - 1]!;
    const after = rows[i]!;
    const gap = direction === "desc" ? key(before) - key(after) : key(after) - key(before);
    if (gap !== 0) {
      expect(gap).toBeGreaterThan(0);
    } else {
      // Tied on the real key, so _id must be doing the deciding.
      expect(before._id < after._id).toBe(true);
    }
  }
}

describe("the comparators are total", () => {
  /*
   * If a comparator returns 0 for two distinct rows, every sort built on it is
   * at the mercy of the input order — and no amount of integration testing
   * surfaces that reliably, because a passing run only means the scan came
   * back the way it did that time.
   */
  type Row = { _id: string; at: number; name: string; sortOrder: number };
  const tied: Row[] = [
    { _id: "b", at: 100, name: "Acme", sortOrder: 0 },
    { _id: "a", at: 100, name: "Acme", sortOrder: 0 },
    { _id: "c", at: 100, name: "Acme", sortOrder: 0 },
  ];

  test("every sort key tied: no comparator calls two different rows equal", () => {
    const pairs: [Row, Row][] = [
      [tied[0]!, tied[1]!],
      [tied[1]!, tied[2]!],
      [tied[0]!, tied[2]!],
    ];
    for (const [x, y] of pairs) {
      expect(byDesc<Row>((r) => r.at)(x, y)).not.toBe(0);
      expect(byAsc<Row>((r) => r.at)(x, y)).not.toBe(0);
      expect(byName<Row>((r) => r.name)(x, y)).not.toBe(0);
      expect(byOrderThenName(x, y)).not.toBe(0);
    }
  });

  test("so the result depends on the data, not on the order it arrived in", () => {
    const forward = [...tied].sort(byDesc((r: Row) => r.at)).map((r) => r._id);
    const reversed = [...tied]
      .reverse()
      .sort(byDesc((r: Row) => r.at))
      .map((r) => r._id);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(["a", "b", "c"]);
  });

  test("an untied key still wins over the tie-break", () => {
    // The _id fallback must never outrank the real key.
    const rows: Row[] = [
      { _id: "a", at: 1, name: "A", sortOrder: 0 },
      { _id: "z", at: 9, name: "Z", sortOrder: 0 },
    ];
    expect(rows.sort(byDesc((r: Row) => r.at)).map((r) => r._id)).toEqual(["z", "a"]);
  });
});

describe("the ledger statement", () => {
  /**
   * A premise worth correcting: tied ledger entries do NOT change a derived
   * balance. A balance is a sum, and addition does not care about order — the
   * total is the same whichever way the rows arrive.
   *
   * What ties change is the STATEMENT. The same three entries listed in two
   * sequences across two refreshes reads to the owner as though something
   * moved. Both halves are asserted below.
   */
  const AT = Date.UTC(2026, 0, 15);

  async function statement(reverse: boolean) {
    const h = harness();
    const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    const owner = asUser(h, userId);
    const { ventureId } = await owner.mutation(api.ventures.create, {
      name: "Consulting",
      type: "consulting",
      currency: "ZAR",
    });

    /*
     * Three entries at the SAME occurredAt. Not contrived: a month's invoices
     * dated the 15th, or a batch import, produces exactly this.
     */
    const amounts = [100000, 200000, 300000];
    for (const amountCents of reverse ? [...amounts].reverse() : amounts) {
      await owner.mutation(api.income.record, {
        ventureId,
        type: "payment_received",
        description: `Retainer ${amountCents}`,
        amountCents,
        currency: "ZAR",
        occurredAt: AT,
      });
    }

    return owner.query(api.income.list, { ventureId });
  }

  test("tied entries come back in an order nothing but the data can change", async () => {
    const forward = await statement(false);
    const reversed = await statement(true);

    // The tie has to be real, or this test proves nothing.
    expect(new Set(forward.map((r) => r.occurredAt)).size).toBe(1);
    assertTotallyOrdered(forward, (r) => r.occurredAt);
    assertTotallyOrdered(reversed, (r) => r.occurredAt);
  });

  test("the same ledger read twice does not reshuffle", async () => {
    // The owner's actual complaint would be "it moved when I refreshed".
    const h = harness();
    const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    const owner = asUser(h, userId);
    const { ventureId } = await owner.mutation(api.ventures.create, {
      name: "Consulting", type: "consulting", currency: "ZAR",
    });
    for (const amountCents of [100000, 200000, 300000]) {
      await owner.mutation(api.income.record, {
        ventureId, type: "payment_received", description: `Retainer ${amountCents}`,
        amountCents, currency: "ZAR", occurredAt: AT,
      });
    }
    const first = await owner.query(api.income.list, { ventureId });
    const second = await owner.query(api.income.list, { ventureId });
    expect(first.map((r) => r._id)).toEqual(second.map((r) => r._id));
  });

  test("and the total is identical either way, because a sum has no order", async () => {
    const sum = (rows: { amountCents: number }[]) =>
      rows.reduce((n, r) => n + r.amountCents, 0);
    expect(sum(await statement(false))).toBe(600000);
    expect(sum(await statement(true))).toBe(600000);
  });
});

describe("the outbox", () => {
  /**
   * Quiet hours make ties SYSTEMATIC rather than rare: every message held
   * overnight is released at the same 08:00, so a night's worth of messages
   * share one `scheduledFor` exactly. This is the sort most likely to be seen
   * shuffling, because it is the one where ties are the normal case.
   */
  async function outbox(reverse: boolean) {
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
        timezone: JHB,
        currency: "ZAR",
        featureFlags: {},
        isDemo: false,
        isSeed: false,
      });
      const locationId = await ctx.db.insert("locations", {
        clientId,
        name: "Hillcrest",
        addressLine: "12 Old Main Rd",
        suburb: "Hillcrest",
        city: "Durban",
        region: "KwaZulu-Natal",
        countryCode: "ZA",
        timezone: JHB,
        active: true,
      });
      const user = await ctx.db.insert("users", { email: "owner@alpha.test" });
      await ctx.db.insert("memberships", {
        userId: user,
        clientId,
        role: "owner",
        active: true,
        acceptedAt: Date.now(),
      });
      return { locationId, user };
    });

    const owner = asUser(h, ids.user);
    const { serviceId } = await owner.mutation(api.services.create, {
      clientSlug: "alpha",
      key: "assessment",
      name: "Assessment",
      durationMinutes: 60,
      priceCents: 95000,
    });

    const people = [
      { name: "Alpha One", phone: "0825550001" },
      { name: "Bravo Two", phone: "0825550002" },
      { name: "Charlie Three", phone: "0825550003" },
    ];

    const bookingIds: Id<"bookings">[] = [];
    for (const [index, person] of (reverse ? [...people].reverse() : people).entries()) {
      const { customerId } = await owner.mutation(api.customers.upsertByPhone, {
        clientSlug: "alpha",
        name: person.name,
        phone: person.phone,
      });
      await owner.mutation(api.customers.recordConsent, {
        clientSlug: "alpha",
        customerId,
        channel: "whatsapp",
        state: "granted",
        lawfulBasis: "consent",
        source: "booking form",
      });
      const { bookingId } = await owner.mutation(api.bookings.book, {
        clientSlug: "alpha",
        locationId: ids.locationId,
        serviceId,
        customerId,
        // Distinct slots, because bookings may not overlap. The tie under test
        // is on scheduledFor, which quiet hours flattens regardless.
        startsAt: Date.UTC(2026, 0, 20, 6 + index),
      });
      bookingIds.push(bookingId);
    }

    // 22:00 SAST. Inside quiet hours, so all three hold to the same 08:00.
    const night = Date.UTC(2026, 0, 5, 20);
    for (const bookingId of bookingIds) {
      await owner.mutation(internal.messages.queueBookingConfirmation, { bookingId, now: night });
    }

    return owner.query(api.messages.outbox, { clientSlug: "alpha" });
  }

  test("messages held to the same instant have a decided order, either way", async () => {
    const forward = await outbox(false);
    const reversed = await outbox(true);

    expect(forward).toHaveLength(3);
    // The tie has to be real: one shared scheduledFor across all three.
    expect(new Set(forward.map((r) => r.scheduledFor)).size).toBe(1);
    assertTotallyOrdered(forward, (r) => r.scheduledFor);
    assertTotallyOrdered(reversed, (r) => r.scheduledFor);
  });
});

describe("accepting a quote does not guess a branch", () => {
  /**
   * The sweep's real finding, and one I wrote. `accept` used `.first()` on the
   * client's locations, so a two-branch business had its job assigned to
   * whichever row the scan returned — a crew sent to the wrong depot, decided
   * by database ordering rather than by a person.
   *
   * The fix is not a better tie-break. There is no correct tie-break for
   * "which branch is this work at": the answer is not in the data. So the
   * question is refused, and the acceptance — which IS the customer's act — is
   * recorded either way.
   */
  async function seed(h: Harness, extraLocations: number) {
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
        timezone: JHB,
        currency: "ZAR",
        featureFlags: {},
        isDemo: false,
        isSeed: false,
      });
      for (let i = 0; i <= extraLocations; i++) {
        await ctx.db.insert("locations", {
          clientId,
          name: i === 0 ? "Hillcrest" : `Branch ${i}`,
          addressLine: `${i + 1} Old Main Rd`,
          suburb: "Hillcrest",
          city: "Durban",
          region: "KwaZulu-Natal",
          countryCode: "ZA",
          timezone: JHB,
          active: true,
        });
      }
      const user = await ctx.db.insert("users", { email: "owner@alpha.test" });
      await ctx.db.insert("memberships", {
        userId: user,
        clientId,
        role: "owner",
        active: true,
        acceptedAt: Date.now(),
      });
      return { user };
    });

    const owner = asUser(h, ids.user);
    const { customerId } = await owner.mutation(api.customers.upsertByPhone, {
      clientSlug: "alpha",
      name: "Thabo M",
      phone: "0825551234",
    });
    const { quoteId, acceptToken } = await owner.mutation(api.quotes.create, {
      clientSlug: "alpha",
      customerId,
      lineItems: [{ description: "5 kW hybrid inverter", quantity: 1, unitPriceCents: 350000 }],
    });
    await owner.mutation(api.quotes.send, { clientSlug: "alpha", quoteId });
    return { acceptToken };
  }

  test("one location: the branch is unambiguous, so the job is created", async () => {
    const h = harness();
    const { acceptToken } = await seed(h, 0);

    const result = await h.mutation(api.public.quote.accept, { token: acceptToken });
    expect(result.jobCreated).toBe(true);
    expect(await h.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(1);
  });

  test("two locations: the acceptance stands and no branch is guessed", async () => {
    const h = harness();
    const { acceptToken } = await seed(h, 1);

    const result = await h.mutation(api.public.quote.accept, { token: acceptToken });

    // The customer said yes. That is their act, and it is recorded either way.
    expect(result.alreadyAccepted).toBe(false);
    const quote = await h.run(async (ctx) => (await ctx.db.query("quotes").collect())[0]);
    expect(quote?.status).toBe("accepted");
    expect(quote?.acceptedAt).toBeGreaterThan(0);

    // But nothing invented a depot on their behalf.
    expect(result.jobCreated).toBe(false);
    expect(await h.run((ctx) => ctx.db.query("jobs").collect())).toEqual([]);
  });

  test("an inactive second branch is not an ambiguity", async () => {
    // Closing a branch should not stop quotes creating jobs at the open one.
    const h = harness();
    const { acceptToken } = await seed(h, 1);
    await h.run(async (ctx) => {
      const rows = await ctx.db.query("locations").collect();
      const closed = rows.find((row) => row.name !== "Hillcrest")!;
      await ctx.db.patch(closed._id, { active: false });
    });

    const result = await h.mutation(api.public.quote.accept, { token: acceptToken });
    expect(result.jobCreated).toBe(true);
  });
});
