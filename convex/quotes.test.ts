import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * QUOTES AND JOBS.
 *
 * What matters here is money that agrees with itself, a bearer token that is
 * not readable from the database, an accept link that is safe to fetch twice,
 * and a job pipeline that cannot claim work was done that was never
 * dispatched.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

async function seed(h: Harness) {
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
    return { ventureId, clientId, locationId, owner };
  });

  const owner = asUser(h, ids.owner);
  const { customerId } = await owner.mutation(api.customers.upsertByPhone, {
    clientSlug: "alpha", name: "Thabo M", phone: "0825551234",
  });
  return { ...ids, owner, customerId };
}

const LINES = [
  { description: "5 kW hybrid inverter", quantity: 1, unitPriceCents: 3_500_00 },
  { description: "Panels", quantity: 8, unitPriceCents: 250_00 },
];

describe("quote money agrees with itself", () => {
  test("the total is computed, never taken from the caller", async () => {
    const h = harness();
    const s = await seed(h);
    const { quoteId, totalCents } = await s.owner.mutation(api.quotes.create, {
      clientSlug: "alpha", customerId: s.customerId, lineItems: LINES,
    });

    // 3500.00 + (8 x 250.00) = 5500.00
    expect(totalCents).toBe(5_500_00);
    const row = await h.run((ctx) => ctx.db.get(quoteId));
    expect(row?.subtotalCents).toBe(5_500_00);
    expect(row?.totalCents).toBe(5_500_00);
  });

  test("a fractional quantity rounds per line, so lines and total agree", async () => {
    /*
     * 2.5 hours at R99.99 is R249.975. Rounded once per line the customer
     * sees R249.98 and the total says R249.98. Summing unrounded and
     * rounding at the end produces a total that disagrees with the lines
     * printed above it, which is the version a customer queries.
     */
    const h = harness();
    const s = await seed(h);
    const { totalCents } = await s.owner.mutation(api.quotes.create, {
      clientSlug: "alpha", customerId: s.customerId,
      lineItems: [{ description: "Labour", quantity: 2.5, unitPriceCents: 99_99 }],
    });
    expect(totalCents).toBe(249_98);
  });

  test("refuses fractional cents on a unit price", async () => {
    const h = harness();
    const s = await seed(h);
    await expect(
      s.owner.mutation(api.quotes.create, {
        clientSlug: "alpha", customerId: s.customerId,
        lineItems: [{ description: "Odd", quantity: 1, unitPriceCents: 100.5 }],
      }),
    ).rejects.toThrow(/BAD_MONEY/);
  });

  test("refuses an empty quote", async () => {
    const h = harness();
    const s = await seed(h);
    await expect(
      s.owner.mutation(api.quotes.create, {
        clientSlug: "alpha", customerId: s.customerId, lineItems: [],
      }),
    ).rejects.toThrow(/EMPTY_QUOTE/);
  });

  test("numbers are sequential and never collide", async () => {
    const h = harness();
    const s = await seed(h);
    const a = await s.owner.mutation(api.quotes.create, {
      clientSlug: "alpha", customerId: s.customerId, lineItems: LINES,
    });
    const b = await s.owner.mutation(api.quotes.create, {
      clientSlug: "alpha", customerId: s.customerId, lineItems: LINES,
    });
    expect(a.number).toBe("QUO-0001");
    expect(b.number).toBe("QUO-0002");
  });
});

describe("the accept token is a bearer credential", () => {
  test("only the HASH is stored", async () => {
    // A database leak must not hand an attacker the ability to accept work
    // in a customer's name.
    const h = harness();
    const s = await seed(h);
    const { quoteId, acceptToken } = await s.owner.mutation(api.quotes.create, {
      clientSlug: "alpha", customerId: s.customerId, lineItems: LINES,
    });

    const row = await h.run((ctx) => ctx.db.get(quoteId));
    expect(row?.acceptTokenHash).toBeTruthy();
    expect(row?.acceptTokenHash).not.toBe(acceptToken);
    expect(JSON.stringify(row)).not.toContain(acceptToken);
  });

  test("a wrong token and an unknown token fail IDENTICALLY", async () => {
    /*
     * A distinct "that quote exists but this token is wrong" tells a stranger
     * which links are real, which is the first step in guessing one. Both
     * failures must be indistinguishable, so both are asserted — an earlier
     * version of this test only tried the unknown token and would have passed
     * against an implementation that leaked the difference.
     */
    const h = harness();
    const s = await seed(h);
    const { acceptToken } = await s.owner.mutation(api.quotes.create, {
      clientSlug: "alpha", customerId: s.customerId, lineItems: LINES,
    });

    // A real token, mutated: same shape, wrong value, against a quote that exists.
    const wrong = acceptToken.slice(0, -1) + (acceptToken.endsWith("a") ? "b" : "a");
    expect(wrong).not.toBe(acceptToken);

    const messageFor = async (token: string) => {
      try {
        await h.mutation(api.public.quote.accept, { token });
        return "NO ERROR";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const wrongMessage = await messageFor(wrong);
    const unknownMessage = await messageFor("nonsense-never-issued");

    expect(wrongMessage).toMatch(/not valid/);
    expect(wrongMessage).toBe(unknownMessage);
  });
});

describe("accepting a quote", () => {
  async function sentQuote(h: Harness) {
    const s = await seed(h);
    const created = await s.owner.mutation(api.quotes.create, {
      clientSlug: "alpha", customerId: s.customerId, lineItems: LINES,
    });
    await s.owner.mutation(api.quotes.markSent, {
      clientSlug: "alpha", quoteId: created.quoteId,
    });
    return { ...s, ...created };
  }

  test("creates a job, with no calendar time reserved", async () => {
    const h = harness();
    const q = await sentQuote(h);

    const result = await h.mutation(api.public.quote.accept, { token: q.acceptToken });
    expect(result).toMatchObject({ number: "QUO-0001", alreadyAccepted: false });

    const jobs = await q.owner.query(api.jobs.list, { clientSlug: "alpha" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "accepted", quoteNumber: "QUO-0001" });
    // A job holds no slot — the hours a crew is on site are bookings.
    expect(jobs[0]!.scheduledFor).toBeNull();

    const bookings = await h.run((ctx) => ctx.db.query("bookings").collect());
    expect(bookings).toHaveLength(0);
  });

  test("is IDEMPOTENT — links get double-tapped and prefetched", async () => {
    /*
     * Mail clients and WhatsApp previews fetch links unprompted. A second
     * accept creating a second job means a crew dispatched twice to a
     * driveway that needed them once.
     */
    const h = harness();
    const q = await sentQuote(h);

    const first = await h.mutation(api.public.quote.accept, { token: q.acceptToken });
    const second = await h.mutation(api.public.quote.accept, { token: q.acceptToken });

    expect(first.alreadyAccepted).toBe(false);
    expect(second.alreadyAccepted).toBe(true);
    expect(second.number).toBe(first.number);

    const jobs = await h.run((ctx) => ctx.db.query("jobs").collect());
    expect(jobs).toHaveLength(1);
  });

  test("refuses an unsent draft", async () => {
    const h = harness();
    const s = await seed(h);
    const { acceptToken } = await s.owner.mutation(api.quotes.create, {
      clientSlug: "alpha", customerId: s.customerId, lineItems: LINES,
    });
    await expect(
      h.mutation(api.public.quote.accept, { token: acceptToken }),
    ).rejects.toThrow(/not been sent/);
  });

  test("refuses an expired quote", async () => {
    const h = harness();
    const q = await sentQuote(h);
    await h.run(async (ctx) => {
      await ctx.db.patch(q.quoteId, { expiresAt: Date.now() - 1000 });
    });

    await expect(
      h.mutation(api.public.quote.accept, { token: q.acceptToken }),
    ).rejects.toThrow(/expired/);
  });

  test("an accepted quote cannot be declined behind the customer's back", async () => {
    const h = harness();
    const q = await sentQuote(h);
    await h.mutation(api.public.quote.accept, { token: q.acceptToken });

    await expect(
      q.owner.mutation(api.quotes.decline, { clientSlug: "alpha", quoteId: q.quoteId }),
    ).rejects.toThrow(/ALREADY_ACCEPTED/);
  });
});

describe("the job pipeline", () => {
  async function job(h: Harness) {
    const s = await seed(h);
    const { jobId } = await s.owner.mutation(api.jobs.create, {
      clientSlug: "alpha", customerId: s.customerId, locationId: s.locationId,
    });
    return { ...s, jobId };
  }

  test("refuses a transition that skips the pipeline", async () => {
    // "complete" arriving before "scheduled" is how a report claims work was
    // done that was never dispatched.
    const h = harness();
    const j = await job(h);
    await expect(
      j.owner.mutation(api.jobs.setStatus, {
        clientSlug: "alpha", jobId: j.jobId, status: "complete",
      }),
    ).rejects.toThrow(/INVALID_TRANSITION/);
  });

  test("refuses 'scheduled' with no date", async () => {
    // A job in the scheduled column that nobody is going to.
    const h = harness();
    const j = await job(h);
    await expect(
      j.owner.mutation(api.jobs.setStatus, {
        clientSlug: "alpha", jobId: j.jobId, status: "scheduled",
      }),
    ).rejects.toThrow(/NOT_SCHEDULED/);
  });

  test("walks the pipeline once a date exists", async () => {
    const h = harness();
    const j = await job(h);
    await j.owner.mutation(api.jobs.schedule, {
      clientSlug: "alpha", jobId: j.jobId, scheduledFor: Date.UTC(2026, 8, 20, 8),
    });
    for (const status of ["in_progress", "complete"] as const) {
      await expect(
        j.owner.mutation(api.jobs.setStatus, { clientSlug: "alpha", jobId: j.jobId, status }),
      ).resolves.toMatchObject({ jobId: j.jobId });
    }
  });

  test("a completed job cannot be rescheduled", async () => {
    const h = harness();
    const j = await job(h);
    await j.owner.mutation(api.jobs.schedule, {
      clientSlug: "alpha", jobId: j.jobId, scheduledFor: Date.UTC(2026, 8, 20, 8),
    });
    await j.owner.mutation(api.jobs.setStatus, {
      clientSlug: "alpha", jobId: j.jobId, status: "in_progress",
    });
    await j.owner.mutation(api.jobs.setStatus, {
      clientSlug: "alpha", jobId: j.jobId, status: "complete",
    });

    await expect(
      j.owner.mutation(api.jobs.schedule, {
        clientSlug: "alpha", jobId: j.jobId, scheduledFor: Date.UTC(2026, 8, 21, 8),
      }),
    ).rejects.toThrow(/JOB_CLOSED/);
  });

  test("materials total per line, and refuse fractional cents", async () => {
    const h = harness();
    const j = await job(h);
    const { materialsCostCents } = await j.owner.mutation(api.jobs.addMaterials, {
      clientSlug: "alpha", jobId: j.jobId,
      materials: [
        { name: "Cable", quantity: 12.5, unitCostCents: 42_00 },
        { name: "Brackets", quantity: 4, unitCostCents: 89_50 },
      ],
    });
    expect(materialsCostCents).toBe(525_00 + 358_00);

    await expect(
      j.owner.mutation(api.jobs.addMaterials, {
        clientSlug: "alpha", jobId: j.jobId,
        materials: [{ name: "Odd", quantity: 1, unitCostCents: 10.5 }],
      }),
    ).rejects.toThrow(/BAD_MONEY/);
  });

  test("a job from a quote must be for the same customer", async () => {
    /*
     * Otherwise the job bills against one person while the accepted document
     * names another, and both records look internally consistent.
     */
    const h = harness();
    const s = await seed(h);
    const { quoteId } = await s.owner.mutation(api.quotes.create, {
      clientSlug: "alpha", customerId: s.customerId, lineItems: LINES,
    });
    const { customerId: other } = await s.owner.mutation(api.customers.upsertByPhone, {
      clientSlug: "alpha", name: "Nomsa K", phone: "0835559999",
    });

    await expect(
      s.owner.mutation(api.jobs.create, {
        clientSlug: "alpha", customerId: other, locationId: s.locationId, quoteId,
      }),
    ).rejects.toThrow(/QUOTE_CUSTOMER_MISMATCH/);
  });
});
