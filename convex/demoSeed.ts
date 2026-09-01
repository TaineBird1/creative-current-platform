import { v, ConvexError } from "convex/values";
import { platformMutation, platformQuery } from "./lib/functions";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { solarTradesTemplate, buildAccentRamp, safeParseSiteConfig } from "@cc/site-config";
import { postEntry } from "./lib/ledger";
import { issueInvoice } from "./invoices";
import { toE164 } from "./lib/phone";

/**
 * A CLICKABLE VERSION OF THE WALKTHROUGH.
 *
 * `walkthrough.test.ts` proves the backend works and prints a transcript.
 * This puts the same week into a real deployment so the screens have
 * something in them — the queue with leads, an invoice part-paid, a P&L with
 * a real net, an inbox with something late.
 *
 * TWO SAFETY PROPERTIES, BOTH DELIBERATE.
 *
 * IT CANNOT RUN ON PRODUCTION. `ALLOW_DEMO_SEED` must be set to "true" on the
 * deployment, and it is set on dev only. A missing flag REFUSES rather than
 * defaulting to permissive — the same shape as the webhook secret, chosen for
 * the same reason: the failure of getting this wrong is fabricated invoices
 * and clients in the deployment that bills real people.
 *
 * IT IS FULLY REMOVABLE. Everything lands under one venture, so `clear`
 * deletes exactly what `run` made by walking that venture's graph. Seed data
 * you cannot delete becomes permanent, and permanent fake clients are how a
 * revenue figure quietly stops meaning anything.
 *
 * WHAT IS REAL AND WHAT IS FIXTURE, stated rather than implied. Money goes
 * through `issueInvoice` and `postEntry` — the same code the office app runs,
 * so the numbering, the issuer snapshot, the VAT decision and the ledger
 * entries are genuine. Bookings, quotes and customers are inserted directly:
 * a mutation cannot call another mutation in Convex, and the auth wrappers
 * are what those rules live behind. The WALKTHROUGH exercises those paths;
 * this produces something to look at.
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

/** The one venture everything hangs off, so `clear` can find all of it. */
const VENTURE_NAME = "Demo — click-through";

function assertSeedingAllowed() {
  if (process.env.ALLOW_DEMO_SEED !== "true") {
    throw bad(
      "SEEDING_NOT_ALLOWED",
      "ALLOW_DEMO_SEED is not set on this deployment. That is deliberate: this creates clients, invoices and ledger entries, and it must never be possible on the deployment that bills real people. Set it on dev only.",
    );
  }
}

const day = (n: number) => n * 24 * 60 * 60 * 1000;

export const run = platformMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    assertSeedingAllowed();

    const existing = (await ctx.db.query("ventures").collect()).find(
      (venture) => venture.name === VENTURE_NAME,
    );
    if (existing) {
      throw bad(
        "ALREADY_SEEDED",
        `"${VENTURE_NAME}" already exists. Run demoSeed:clear first — re-seeding on top would double every figure, which is worse than refusing.`,
      );
    }

    const now = args.now ?? Date.now();
    const actor = ctx.platform.userId;

    const ventureId = await ctx.db.insert("ventures", {
      name: VENTURE_NAME,
      type: "platform",
      currency: "ZAR",
      active: true,
      sortOrder: 99,
    });

    /*
     * The issuer is created ALREADY CONFIRMED, because an unconfirmed one
     * refuses to invoice and there would be nothing to click. The legal name
     * says what it is: a name a person has to replace, not one to trust.
     */
    await ctx.db.insert("issuers", {
      ventureId,
      legalName: "DEMO SEED — not a real legal name",
      tradingName: "The Creative Current",
      addressLine: "12 Old Main Road",
      suburb: "Hillcrest",
      city: "Durban",
      countryCode: "ZA",
      email: "hello@thecreativecurrent.co.za",
      bankName: "FNB",
      bankAccountNumber: "62000000000",
      bankBranchCode: "250655",
      updatedAt: now,
      confirmedAt: now,
      confirmedBy: actor,
    });

    // ---- leads, so the queue has a morning in it -------------------------
    const leads: Id<"leads">[] = [];
    const roster: [string, string | null, string][] = [
      ["Hillcrest Solar", "0825550001", "Hillcrest"],
      ["Ballito Renewables", "0825550003", "Ballito"],
      ["Kloof Electrical", "0825550004", "Kloof"],
      ["Umhlanga Power", "0825550005", "Umhlanga"],
      // No number: lands in the research bucket, not the call queue.
      ["Pinetown Solar Co", null, "Pinetown"],
      ["North Coast Energy", null, "Ballito"],
    ];
    for (const [businessName, phone, area] of roster) {
      const parsed = phone ? toE164(phone) : null;
      leads.push(
        await ctx.db.insert("leads", {
          ventureId,
          businessName,
          niche: "solar",
          phone: parsed?.ok ? parsed.e164 : undefined,
          phoneDisplay: phone ?? undefined,
          area,
          auditFaults:
            businessName === "Hillcrest Solar"
              ? ["No HTTPS", "No phone above the fold"]
              : ["Site loads in 6s on 3G"],
          callNote: businessName === "Hillcrest Solar" ? "Owner answers directly" : undefined,
          status: "new",
          provenance: {
            source: "campaign_list",
            capturedAt: now - day(7),
            lawfulBasis: "legitimate_interest",
            detail: `SolarZA directory listing (${area})`,
          },
        }),
      );
    }

    /*
     * One lead already worked and discarded, so the queue count visibly does
     * not match the lead count.
     *
     * It does NOT write a suppression, deliberately. `lib/suppression.ts` is
     * the only module allowed near that table and a guard test says so — the
     * rule exists because a second reader is a second place that can decide
     * who may be contacted. A seeder is not worth an exception to it, and a
     * discarded lead demonstrates the same thing.
     */
    await ctx.db.patch(leads[3]!, { status: "discarded" });

    // ---- a client who signed --------------------------------------------
    const clientId = await ctx.db.insert("clients", {
      ventureId,
      kind: "platform",
      name: "Hillcrest Solar (demo)",
      slug: "demo-hillcrest-solar",
      status: "live",
      timezone: "Africa/Johannesburg",
      currency: "ZAR",
      featureFlags: {},
      isDemo: false,
      isSeed: false,
    });
    const locationId = await ctx.db.insert("locations", {
      clientId,
      name: "Hillcrest",
      addressLine: "3 Old Main Road",
      suburb: "Hillcrest",
      city: "Durban",
      region: "KwaZulu-Natal",
      countryCode: "ZA",
      timezone: "Africa/Johannesburg",
      active: true,
    });
    await ctx.db.insert("memberships", {
      userId: actor,
      clientId,
      role: "owner",
      active: true,
      acceptedAt: now,
    });

    const config = solarTradesTemplate({
      businessName: "Hillcrest Solar",
      slug: "demo-hillcrest-solar",
      brandColour: "#1f6f43",
      accent: buildAccentRamp("#1f6f43"),
      city: "Durban",
      region: "KwaZulu-Natal",
      suburb: "Hillcrest",
      addressLine: "3 Old Main Road",
      phone: "+27825550001",
    });
    /*
     * Parsed before it is stored, same as siteConfigs and demos. The guard
     * that caught this was right: an unparsed config does not fail here, it
     * fails at render time on a page somebody has opened.
     */
    const parsed = safeParseSiteConfig(config);
    if (!parsed.success) {
      throw bad("INVALID_CONFIG", "The seeded site config did not validate.");
    }

    const siteId = await ctx.db.insert("sites", {
      clientId,
      slug: "demo-hillcrest-solar",
      status: "live",
      config: parsed.data,
      publishedConfig: parsed.data,
      version: 1,
      configSchemaVersion: 1,
      isDemo: false,
    });

    const serviceId = await ctx.db.insert("services", {
      clientId,
      key: "assessment",
      name: "Site assessment",
      durationMinutes: 60,
      priceCents: 95_000,
      currency: "ZAR",
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
      active: true,
      sortOrder: 1,
      quoteRequired: false,
    });
    const customerId = await ctx.db.insert("customers", {
      clientId,
      name: "Thandi M",
      phone: "+27825559911",
      addresses: [],
      currency: "ZAR",
      tags: [],
      visitCount: 0,
      noShowCount: 0,
      lifetimeValueCents: 0,
      /*
       * NOT marked demo or seed. Those flags block messaging and money, and
       * a customer that cannot be messaged shows nothing on the screens this
       * exists to fill. The deployment flag is what keeps this off prod.
       */
      isDemo: false,
      isSeed: false,
    });
    await ctx.db.insert("bookings", {
      clientId,
      customerId,
      locationId,
      serviceId,
      startsAt: now + day(3),
      endsAt: now + day(3) + 60 * 60 * 1000,
      status: "confirmed",
      source: "back_office",
      messageRevision: 1,
      isDemo: false,
    });

    // ---- money, through the real path ------------------------------------
    const invoice = await issueInvoice(
      ctx,
      {
        clientId,
        lineItems: [
          { description: "Website build", quantity: 1, unitPriceCents: 18_000_00 },
          { description: "Care plan, first month", quantity: 1, unitPriceCents: 950_00 },
        ],
        now: now - day(10),
      },
      actor,
    );

    /* Part paid on purpose: a settled invoice shows one state, a part-paid
     * one shows three — paid, owed, and still overdue on the remainder. */
    await postEntry(ctx, {
      ventureId,
      clientId,
      invoiceId: invoice.invoiceId,
      type: "payment_received",
      amountCents: 15_000_00,
      currency: "ZAR",
      occurredAt: now - day(2),
      description: `Payment for ${invoice.number}`,
      createdBy: actor,
    });

    const second = await issueInvoice(
      ctx,
      {
        clientId,
        lineItems: [{ description: "Care plan, month two", quantity: 1, unitPriceCents: 950_00 }],
        now: now - day(1),
      },
      actor,
    );

    for (const [description, category, amountCents] of [
      ["Vercel Pro", "hosting", 40_00],
      ["Convex", "hosting", 45_00],
      ["Domain renewal", "hosting", 21_00],
    ] as const) {
      await ctx.db.insert("expenses", {
        ventureId,
        description,
        category,
        amountCents,
        currency: "ZAR",
        incurredAt: now - day(5),
        recurring: true,
      });
    }

    // ---- the inbox --------------------------------------------------------
    await ctx.db.insert("tasks", {
      ventureId,
      clientId,
      title: "Send Hillcrest the care-plan agreement",
      dueAt: now - day(2),
      status: "open",
    });
    await ctx.db.insert("tasks", {
      ventureId,
      title: "Chase the leads with no number",
      dueAt: now + day(1),
      status: "open",
    });
    await ctx.db.insert("tasks", {
      ventureId,
      title: "Rewrite the about page",
      status: "open",
    });

    return {
      ventureId,
      clientId,
      siteId,
      leads: leads.length,
      invoices: [invoice.number, second.number],
      /** Where to look, in the order it makes sense. */
      screens: ["/admin/queue", "/admin/tasks", "/admin", "/admin/finance"],
    };
  },
});

/**
 * Remove everything `run` made.
 *
 * Walks the venture's graph rather than matching on names, because a name
 * match would leave orphans the moment a row was renamed — and an orphaned
 * ledger entry is a number in a P&L with nothing behind it.
 */
export const clear = platformMutation({
  args: {},
  handler: async (ctx) => {
    assertSeedingAllowed();

    const venture = (await ctx.db.query("ventures").collect()).find(
      (row) => row.name === VENTURE_NAME,
    );
    if (!venture) return { deleted: 0, ventureFound: false as const };

    let deleted = 0;
    const kill = async (id: Id<never>) => {
      await ctx.db.delete(id);
      deleted++;
    };

    const clients = (await ctx.db.query("clients").collect()).filter(
      (row) => row.ventureId === venture._id,
    );
    const clientIds = new Set(clients.map((row) => row._id as string));

    /*
     * Client-scoped rows first, then venture-scoped, then the venture. A
     * ledger entry outliving its client is exactly the orphan this ordering
     * avoids.
     */
    for (const table of [
      "bookings",
      "quotes",
      "jobs",
      "services",
      "customers",
      "locations",
      "sites",
      "memberships",
      "consents",
      "messages",
      "quoteRequests",
      "invoices",
    ] as const) {
      for (const row of await ctx.db.query(table).collect()) {
        const owner = (row as { clientId?: string }).clientId;
        if (owner && clientIds.has(owner)) await kill(row._id as Id<never>);
      }
    }

    for (const table of [
      "ledgerEntries",
      "expenses",
      "tasks",
      "leads",
      "deals",
      "invoiceCounters",
      "issuers",
      "auditLog",
    ] as const) {
      for (const row of await ctx.db.query(table).collect()) {
        const owner = (row as { ventureId?: string }).ventureId;
        const client = (row as { clientId?: string }).clientId;
        if (owner === venture._id || (client && clientIds.has(client))) {
          await kill(row._id as Id<never>);
        }
      }
    }

    for (const client of clients) await kill(client._id as Id<never>);

    await kill(venture._id as Id<never>);
    return { deleted, ventureFound: true as const };
  },
});

/** Whether the seed is present, and whether this deployment even allows it. */
export const status = platformQuery({
  args: {},
  handler: async (ctx) => {
    const venture = (await ctx.db.query("ventures").collect()).find(
      (row) => row.name === VENTURE_NAME,
    );
    return {
      allowed: process.env.ALLOW_DEMO_SEED === "true",
      seeded: venture !== undefined,
      ventureId: venture?._id ?? null,
    };
  },
});

/** Unused import guard: MutationCtx is referenced by the helper signature. */
export type _Ctx = MutationCtx;
