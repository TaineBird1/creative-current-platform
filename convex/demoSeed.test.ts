import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

/**
 * THE SEEDER, AND WHY IT GOES THROUGH THE REAL PATHS.
 *
 * A seeder exists so screens can be judged before a client does. That only
 * works if the data behaves the way production data behaves — so the moment it
 * writes rows of its own, every screen built against it is being judged
 * against something that is not the thing.
 *
 * The first version inserted a booking directly, which meant deleting the
 * guard that keeps `bookings.ts` the only writer of `startsAt`. These tests
 * pin the alternative: it calls `createBooking` and `insertSite` and
 * `issueInvoiceFor`, gets their rules, and the guards stay whole.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);

const SEP = Date.UTC(2026, 8, 2, 9);

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seeded() {
  const h = harness();
  vi.stubEnv("ALLOW_DEMO_SEED", "true");
  const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
    email: "owner@thecreativecurrent.co.za",
  });
  const owner = h.withIdentity({ subject: `${userId}|test-session` });
  await owner.mutation(api.demoSeed.run, { now: SEP });
  return { h, owner };
}

describe("it cannot run where it must not", () => {
  test("the deployment flag is required, and absent means no", async () => {
    const h = harness();
    const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    vi.stubEnv("ALLOW_DEMO_SEED", "");

    await expect(
      h.withIdentity({ subject: `${userId}|test-session` }).mutation(api.demoSeed.run, {}),
    ).rejects.toThrow(/ALLOW_DEMO_SEED/);
    expect(await h.run((ctx) => ctx.db.query("clients").collect())).toEqual([]);
  });
});

describe("the booking behaves like a real one", () => {
  test("IT WENT THROUGH createBooking, so it carries a message revision", async () => {
    const { h } = await seeded();
    const booking = (await h.run((ctx) => ctx.db.query("bookings").first()))!;
    expect(booking.messageRevision).toBe(1);
    expect(booking.status).toBe("confirmed");
  });

  test("AND ITS CONFIRMATION IS IN THE OUTBOX", async () => {
    /*
     * The whole reason for the change. A seeded booking with no queued
     * confirmation shows an outbox that is empty for a reason production
     * would never have.
     */
    const { h } = await seeded();
    const messages = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(messages).toHaveLength(1);
    expect(messages[0]!.templateKey).toBe("booking_confirmation");
  });

  test("addressed to an RFC-RESERVED domain that can never be a person", async () => {
    /*
     * `example.com` is reserved by RFC 2606: it cannot be registered and does
     * not resolve. That is what keeps the seeder safe even if the send
     * allowlist is widened later — which is exactly when a plausible-looking
     * seeded address would start reaching somebody.
     */
    const { h } = await seeded();
    const messages = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(messages[0]!.channel).toBe("email");
    expect(messages[0]!.to).toMatch(/@example\.com$/);
  });

  test("and the consent the booking establishes is there too", async () => {
    const { h } = await seeded();
    const consent = await h.run((ctx) => ctx.db.query("consents").first());
    expect(consent?.lawfulBasis).toBe("contract");
    expect(consent?.source).toBe("made a booking");
  });

  test("THE OVERLAP CHECK APPLIES, because it is the same function", async () => {
    // A seeder that skipped it would let you build a calendar screen against
    // data the real calendar could never contain.
    const { h, owner } = await seeded();
    const { clientId, locationId, serviceId, customerId, startsAt } = await h.run(
      async (ctx) => {
        const b = (await ctx.db.query("bookings").first())!;
        return {
          clientId: b.clientId, locationId: b.locationId,
          serviceId: b.serviceId, customerId: b.customerId, startsAt: b.startsAt,
        };
      },
    );
    const client = (await h.run((ctx) => ctx.db.get(clientId)))!;

    await expect(
      owner.mutation(api.bookings.book, {
        clientSlug: client.slug!,
        locationId,
        serviceId,
        customerId,
        startsAt,
      }),
    ).rejects.toThrow(/SLOT_TAKEN/);
  });
});

describe("the rest of it still lands", () => {
  test("a site that resolves publicly, written through insertSite", async () => {
    const { h } = await seeded();
    const site = (await h.run((ctx) => ctx.db.query("sites").first()))!;
    expect(site.isDemo).toBe(false);
    expect(site.publishedConfig).toBeDefined();

    const resolved = await h.query(api.public.site.resolve, { slug: site.slug });
    expect(resolved.kind).toBe("site");
  });

  test("two invoices, numbered in sequence, through the real issuer", async () => {
    const { h } = await seeded();
    const invoices = await h.run((ctx) => ctx.db.query("invoices").collect());
    expect(invoices).toHaveLength(2);
    expect(invoices.map((i) => i.numberSeq).sort()).toEqual([1, 2]);
    // Snapshotted, not joined — see invoices.ts.
    expect(invoices[0]!.issuerLegalName).toBeTruthy();
  });

  test("a part-paid invoice, so a screen shows three states and not one", async () => {
    const { h } = await seeded();
    const entries = await h.run((ctx) => ctx.db.query("ledgerEntries").collect());
    expect(entries.some((e) => e.type === "invoice_issued")).toBe(true);
    expect(entries.some((e) => e.type === "payment_received")).toBe(true);
  });

  test("and every invoice names an actor, because the signature requires one", async () => {
    const { h } = await seeded();
    const audit = await h.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "invoice.issue"))
        .collect(),
    );
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.actorUserId)).toBe(true);
  });
});
