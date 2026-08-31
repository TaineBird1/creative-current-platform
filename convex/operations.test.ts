import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * SERVICES, CUSTOMERS AND CONSENT.
 *
 * The nouns a booking flow needs. What is worth asserting is not that rows
 * save — it is the handful of states that are individually valid and jointly
 * wrong: a service nobody can price, a customer who quietly becomes two, a
 * consent record that answers "do they consent" but not "did they consent
 * when we sent that".
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

async function seedTenant(h: Harness) {
  return h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Alpha Solar", slug: "alpha", status: "live",
      timezone: "Africa/Johannesburg", currency: "ZAR",
      featureFlags: {}, isDemo: false, isSeed: false,
    });
    const otherId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Bravo Solar", slug: "bravo", status: "live",
      timezone: "Africa/Johannesburg", currency: "ZAR",
      featureFlags: {}, isDemo: false, isSeed: false,
    });

    const mkUser = (email: string) => ctx.db.insert("users", { email });
    const owner = await mkUser("owner@alpha.test");
    const staff = await mkUser("staff@alpha.test");
    const bravoOwner = await mkUser("owner@bravo.test");

    const mkMembership = (
      userId: Id<"users">, client: Id<"clients">, role: "owner" | "manager" | "staff",
    ) => ctx.db.insert("memberships", {
      userId, clientId: client, role, active: true, acceptedAt: Date.now(),
    });

    await mkMembership(owner, clientId, "owner");
    await mkMembership(staff, clientId, "staff");
    await mkMembership(bravoOwner, otherId, "owner");

    return { clientId, otherId, owner, staff, bravoOwner };
  });
}

const service = (over: Record<string, unknown> = {}) => ({
  clientSlug: "alpha",
  key: "solar-assessment",
  name: "Solar assessment",
  durationMinutes: 60,
  priceCents: 95000,
  ...over,
});

describe("services", () => {
  test("creates one and reports the slot it really consumes", async () => {
    // Buffers are not free time. A 60-minute job with a 15-minute drive
    // either side occupies 90, and a calendar that books it as 60 double-books.
    const h = harness();
    const s = await seedTenant(h);
    const owner = asUser(h, s.owner);

    await owner.mutation(api.services.create, service({
      bufferBeforeMinutes: 15, bufferAfterMinutes: 15,
    }));

    const rows = await owner.query(api.services.list, { clientSlug: "alpha" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "solar-assessment", durationMinutes: 60, totalMinutes: 90, currency: "ZAR",
    });
  });

  test("REFUSES a service with no price and no quote flow", async () => {
    /*
     * Both fields are individually valid, and together they make a dead end:
     * a visitor picks it on the public site and is shown neither a number nor
     * a way to ask for one. Nothing downstream catches this.
     */
    const h = harness();
    const s = await seedTenant(h);
    await expect(
      asUser(h, s.owner).mutation(
        api.services.create,
        service({ priceCents: undefined, quoteRequired: false }),
      ),
    ).rejects.toThrow(/UNPRICEABLE_SERVICE/);
  });

  test("allows no price when a quote is required", async () => {
    const h = harness();
    const s = await seedTenant(h);
    await expect(
      asUser(h, s.owner).mutation(
        api.services.create,
        service({ priceCents: undefined, quoteRequired: true }),
      ),
    ).resolves.toMatchObject({ key: "solar-assessment" });
  });

  test("can move a service from fixed-price to quote-only", async () => {
    // `priceCents: undefined` means "leave alone", so clearing needs its own
    // signal — otherwise a trades business could never switch a job to quoted.
    const h = harness();
    const s = await seedTenant(h);
    const owner = asUser(h, s.owner);
    const { serviceId } = await owner.mutation(api.services.create, service());

    await owner.mutation(api.services.update, {
      clientSlug: "alpha", serviceId, clearPrice: true, quoteRequired: true,
    });

    const [row] = await owner.query(api.services.list, { clientSlug: "alpha" });
    expect(row!.priceCents).toBeNull();
    expect(row!.quoteRequired).toBe(true);
  });

  test("refuses to make an existing service unpriceable on update", async () => {
    const h = harness();
    const s = await seedTenant(h);
    const owner = asUser(h, s.owner);
    const { serviceId } = await owner.mutation(api.services.create, service());

    await expect(
      owner.mutation(api.services.update, {
        clientSlug: "alpha", serviceId, clearPrice: true, quoteRequired: false,
      }),
    ).rejects.toThrow(/UNPRICEABLE_SERVICE/);
  });

  test("refuses a duplicate key — a SiteConfig points at services by key", async () => {
    const h = harness();
    const s = await seedTenant(h);
    const owner = asUser(h, s.owner);
    await owner.mutation(api.services.create, service());

    await expect(
      owner.mutation(api.services.create, service({ name: "Another name" })),
    ).rejects.toThrow(/DUPLICATE_KEY/);
  });

  test("staff cannot change the catalogue", async () => {
    // Structure is owner-tier: the same service meaning two things in two
    // branches breaks reporting quietly.
    const h = harness();
    const s = await seedTenant(h);
    await expect(
      asUser(h, s.staff).mutation(api.services.create, service()),
    ).rejects.toThrow();
  });

  test("another tenant's owner sees nothing and cannot write", async () => {
    const h = harness();
    const s = await seedTenant(h);
    await asUser(h, s.owner).mutation(api.services.create, service());

    await expect(
      asUser(h, s.bravoOwner).query(api.services.list, { clientSlug: "alpha" }),
    ).rejects.toThrow();
  });
});

describe("customers", () => {
  const person = { clientSlug: "alpha", name: "Thabo M", phone: "082 555 1234" };

  test("the same person in three formats is ONE customer", async () => {
    /*
     * "082 555 1234", "0825551234" and "+27 82 555 1234" are the same human.
     * Without normalising at the write, the merge tooling exists to clean up
     * a mess the write path created.
     */
    const h = harness();
    const s = await seedTenant(h);
    const staff = asUser(h, s.staff);

    const a = await staff.mutation(api.customers.upsertByPhone, person);
    const b = await staff.mutation(api.customers.upsertByPhone, {
      ...person, phone: "0825551234",
    });
    const c = await staff.mutation(api.customers.upsertByPhone, {
      ...person, phone: "+27 82 555 1234",
    });

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(c.created).toBe(false);
    expect(b.customerId).toBe(a.customerId);
    expect(c.customerId).toBe(a.customerId);

    const rows = await staff.query(api.customers.list, { clientSlug: "alpha" });
    expect(rows).toHaveLength(1);
  });

  test("a booking form NEVER overwrites the spec notes", async () => {
    // The notes are what the business is paid to remember. A customer
    // retyping their name must not erase "gate code, dog in the yard".
    const h = harness();
    const s = await seedTenant(h);
    const owner = asUser(h, s.owner);

    const { customerId } = await owner.mutation(api.customers.upsertByPhone, person);
    await owner.mutation(api.customers.setNotes, {
      clientSlug: "alpha", customerId, notes: "Gate code 1978. Dog in the yard.",
    });
    await owner.mutation(api.customers.upsertByPhone, { ...person, name: "Thabo Mokoena" });

    const [row] = await owner.query(api.customers.list, { clientSlug: "alpha" });
    expect(row!.notes).toBe("Gate code 1978. Dog in the yard.");
    expect(row!.name).toBe("Thabo Mokoena");
  });

  test("merging leaves a tombstone and keeps the history", async () => {
    const h = harness();
    const s = await seedTenant(h);
    const owner = asUser(h, s.owner);

    const { customerId: keepId } = await owner.mutation(api.customers.upsertByPhone, person);
    const { customerId: mergeId } = await owner.mutation(api.customers.upsertByPhone, {
      clientSlug: "alpha", name: "T Mokoena", phone: "083 111 2222",
    });
    await h.run(async (ctx) => {
      await ctx.db.patch(keepId, { visitCount: 3, lifetimeValueCents: 300_00 });
      await ctx.db.patch(mergeId, { visitCount: 2, lifetimeValueCents: 200_00 });
    });

    await owner.mutation(api.customers.merge, { clientSlug: "alpha", keepId, mergeId });

    const kept = await h.run((ctx) => ctx.db.get(keepId));
    expect(kept?.visitCount).toBe(5);
    expect(kept?.lifetimeValueCents).toBe(500_00);

    // The loser still exists, pointing at the winner.
    const loser = await h.run((ctx) => ctx.db.get(mergeId));
    expect(loser).not.toBeNull();
    expect(loser?.mergedIntoId).toBe(keepId);

    // And the default list hides it rather than showing a duplicate.
    const rows = await owner.query(api.customers.list, { clientSlug: "alpha" });
    expect(rows).toHaveLength(1);
  });

  test("booking a merged-away number resolves to the surviving record", async () => {
    const h = harness();
    const s = await seedTenant(h);
    const owner = asUser(h, s.owner);

    const { customerId: keepId } = await owner.mutation(api.customers.upsertByPhone, person);
    const { customerId: mergeId } = await owner.mutation(api.customers.upsertByPhone, {
      clientSlug: "alpha", name: "T Mokoena", phone: "083 111 2222",
    });
    await owner.mutation(api.customers.merge, { clientSlug: "alpha", keepId, mergeId });

    const again = await owner.mutation(api.customers.upsertByPhone, {
      clientSlug: "alpha", name: "T Mokoena", phone: "083 111 2222",
    });
    expect(again.customerId).toBe(keepId);
    expect(again.created).toBe(false);
  });

  test("a customer from another tenant cannot be read or merged", async () => {
    const h = harness();
    const s = await seedTenant(h);
    const { customerId } = await asUser(h, s.owner).mutation(
      api.customers.upsertByPhone, person,
    );

    await expect(
      asUser(h, s.bravoOwner).query(api.customers.consentState, {
        clientSlug: "bravo", customerId,
      }),
    ).rejects.toThrow();
  });
});

describe("consent", () => {
  const person = { clientSlug: "alpha", name: "Thabo M", phone: "0825551234" };

  test("a channel with no record is NULL, not granted", async () => {
    /*
     * The distinction the messaging pipeline depends on. A boolean would
     * collapse "never asked" into "no", which is right, and into "false"
     * which reads as a decision the customer made. Absent is absent.
     */
    const h = harness();
    const s = await seedTenant(h);
    const staff = asUser(h, s.staff);
    const { customerId } = await staff.mutation(api.customers.upsertByPhone, person);

    await expect(
      staff.query(api.customers.consentState, { clientSlug: "alpha", customerId }),
    ).resolves.toEqual({ whatsapp: null, email: null, sms: null });
  });

  test("withdrawal is a NEW row, so the history survives", async () => {
    // "Did they consent on the day we sent that" must stay answerable.
    // Overwriting the state destroys the evidence the send was lawful.
    const h = harness();
    const s = await seedTenant(h);
    const staff = asUser(h, s.staff);
    const { customerId } = await staff.mutation(api.customers.upsertByPhone, person);

    await staff.mutation(api.customers.recordConsent, {
      clientSlug: "alpha", customerId, channel: "whatsapp",
      state: "granted", lawfulBasis: "consent", source: "booking form",
    });
    await staff.mutation(api.customers.recordConsent, {
      clientSlug: "alpha", customerId, channel: "whatsapp",
      state: "withdrawn", lawfulBasis: "consent", source: "replied STOP",
    });

    const state = await staff.query(api.customers.consentState, {
      clientSlug: "alpha", customerId,
    });
    expect(state.whatsapp).toBe("withdrawn");

    const rows = await h.run((ctx) => ctx.db.query("consents").collect());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.state).sort()).toEqual(["granted", "withdrawn"]);
  });

  test("channels are independent", async () => {
    const h = harness();
    const s = await seedTenant(h);
    const staff = asUser(h, s.staff);
    const { customerId } = await staff.mutation(api.customers.upsertByPhone, person);

    await staff.mutation(api.customers.recordConsent, {
      clientSlug: "alpha", customerId, channel: "whatsapp",
      state: "granted", lawfulBasis: "consent", source: "booking form",
    });

    const state = await staff.query(api.customers.consentState, {
      clientSlug: "alpha", customerId,
    });
    expect(state).toEqual({ whatsapp: "granted", email: null, sms: null });
  });

  test("consent needs a source — where it was given is the evidence", async () => {
    const h = harness();
    const s = await seedTenant(h);
    const staff = asUser(h, s.staff);
    const { customerId } = await staff.mutation(api.customers.upsertByPhone, person);

    await expect(
      staff.mutation(api.customers.recordConsent, {
        clientSlug: "alpha", customerId, channel: "email",
        state: "granted", lawfulBasis: "consent", source: "   ",
      }),
    ).rejects.toThrow(/INVALID/);
  });
});
