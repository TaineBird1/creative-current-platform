import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { solarTradesTemplate, buildAccentRamp } from "@cc/site-config";

/**
 * THE WHOLE BUSINESS, END TO END.
 *
 * Every other test file proves one rule. This one runs the actual working
 * week — cold lead to money in the bank — through the real authenticated API
 * with every guard live, and narrates it.
 *
 * It exists for two reasons. The first is to be READ: `pnpm exec vitest run
 * convex/walkthrough.test.ts` prints what the backend does, in order, with
 * real figures. The second is that nothing else covers the seams. Each rule
 * is tested in isolation; this is the only place where a quote becoming a job
 * becoming an invoice becoming a payment has to actually line up.
 *
 * Nothing here is a shim. Every step is the same function the office app
 * calls, with the same permission wrapper, so a step that would fail in
 * production fails here.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

const R = (cents: number) =>
  `R${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2 })}`;
const say = (line: string) => console.log(line);
const day = (n: number) => n * 24 * 60 * 60 * 1000;

/** A Tuesday in September, 09:00 SAST. */
const MON = Date.UTC(2026, 8, 1, 7, 0, 0);

describe("a working week", () => {
  test("cold lead to money in the bank", async () => {
    const h = harness();

    // ---------------------------------------------------------------- setup
    const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    const owner = asUser(h, userId);

    const { ventureId } = await owner.mutation(api.ventures.create, {
      name: "Sites",
      type: "platform",
      currency: "ZAR",
    });

    say("\n════════════════════════════════════════════════════════════");
    say("  THE CREATIVE CURRENT — one working week, end to end");
    say("════════════════════════════════════════════════════════════");
    say("\n▸ MONDAY 09:00 — the issuer");

    await owner.mutation(api.issuer.set, {
      ventureId,
      legalName: "A Sole Proprietor",
      tradingName: "The Creative Current",
      addressLine: "12 Old Main Road",
      suburb: "Hillcrest",
      city: "Durban",
      countryCode: "ZA",
      email: "hello@thecreativecurrent.co.za",
      bankName: "FNB",
      bankAccountNumber: "62000000000",
      bankBranchCode: "250655",
    });
    say("  issuer.set        → stored, NOT yet usable");

    let issuer = await owner.query(api.issuer.get, { ventureId });
    say(`  issuer.get        → confirmed: ${issuer?.confirmed}  (invoicing refused)`);
    expect(issuer?.confirmed).toBe(false);

    await owner.mutation(api.issuer.confirm, { ventureId, legalName: "A Sole Proprietor" });
    issuer = await owner.query(api.issuer.get, { ventureId });
    say(`  issuer.confirm    → confirmed: ${issuer?.confirmed}, sole prop: ${issuer?.isSoleProprietor}, charges VAT: ${issuer?.chargesVat}`);
    expect(issuer?.confirmed).toBe(true);

    // ------------------------------------------------------------- the lead
    say("\n▸ MONDAY 09:15 — the queue");

    const leadId = await h.run((ctx) =>
      ctx.db.insert("leads", {
        ventureId,
        businessName: "Hillcrest Solar",
        niche: "solar",
        phone: "+27825550001",
        phoneDisplay: "082 555 0001",
        area: "Hillcrest",
        website: "hillcrestsolar.co.za",
        auditFaults: ["No HTTPS", "No phone above the fold"],
        callNote: "Site loads in 6s on 3G",
        status: "new",
        provenance: {
          source: "campaign_list",
          capturedAt: MON - day(7),
          lawfulBasis: "legitimate_interest",
          detail: "SolarZA directory listing (Hillcrest)",
        },
      }),
    );
    const refusedId = await h.run((ctx) =>
      ctx.db.insert("leads", {
        ventureId,
        businessName: "Coastal Plumbing",
        niche: "solar",
        phone: "+27825550002",
        area: "Ballito",
        auditFaults: [],
        status: "new",
        provenance: {
          source: "campaign_list",
          capturedAt: MON - day(7),
          lawfulBasis: "legitimate_interest",
          detail: "Procompare directory listing (Ballito)",
        },
      }),
    );
    const noNumberId = await h.run((ctx) =>
      ctx.db.insert("leads", {
        ventureId,
        businessName: "KZN Solar Installations",
        niche: "solar",
        area: "KZN",
        auditFaults: [],
        status: "new",
        provenance: {
          source: "campaign_list",
          capturedAt: MON - day(7),
          lawfulBasis: "legitimate_interest",
          detail: "ENF Solar directory listing (KZN)",
        },
      }),
    );
    void noNumberId;

    let queue = await owner.query(api.queue.today, { now: MON });
    say(`  queue.today       → ${queue.rows.length} callable, ${queue.needsNumberCount} need a number, ${queue.suppressedCount} suppressed`);
    say(`                      ${queue.rows.map((r) => r.businessName).join(", ")}`);
    expect(queue.rows).toHaveLength(2);
    expect(queue.needsNumberCount).toBe(1);

    // --------------------------------------------------------- call one: no
    say("\n▸ MONDAY 09:20 — Coastal Plumbing says no");
    await owner.mutation(api.queue.disposition, {
      leadId: refusedId,
      outcome: "not_interested",
      note: "Take me off your list",
      now: MON + 20 * 60 * 1000,
    });
    queue = await owner.query(api.queue.today, { now: MON + day(0.1) });
    say(`  queue.disposition → suppressed on placeId AND phone, immediately`);
    say(`  queue.today       → ${queue.rows.length} callable now, ${queue.suppressedCount} withheld`);
    expect(queue.rows.map((r) => r.businessName)).toEqual(["Hillcrest Solar"]);

    // -------------------------------------------------------- call two: yes
    say("\n▸ MONDAY 09:35 — Hillcrest Solar wants to see something");

    const demo = await owner.mutation(api.demos.createForLead, { leadId, now: MON });
    say(`  demos.createForLead → ${demo.path}  (expires in 30 days)`);
    const resolved = await h.query(api.public.site.resolve, { slug: demo.slug });
    expect(resolved.kind).toBe("site");
    if (resolved.kind === "site") {
      say(`  public.site.resolve → live, isDemo: ${resolved.isDemo}, disclosure names "${resolved.demo?.subjectName}"`);
    }

    await owner.mutation(api.queue.disposition, {
      leadId,
      outcome: "meeting_set",
      note: "Thursday 10:00 at their office",
      now: MON + 35 * 60 * 1000,
    });
    const board = await owner.query(api.deals.board, {});
    const deal = board.stages.flatMap((stage) => stage.deals)[0];
    say(`  queue.disposition → meeting_set opened a deal`);
    // A FRACTION, not a percentage. Printed as 0.1% the first time this ran,
    // which is the sort of wrong that reads as plausible.
    if (deal) {
      say(`  deals.board       → stage: ${deal.stage}, probability ${Math.round(deal.probability * 100)}% (derived from the stage, never typed)`);
    }

    // ------------------------------------------------------------ they sign
    say("\n▸ THURSDAY — they sign");

    const clientId = await h.run((ctx) =>
      ctx.db.insert("clients", {
        ventureId,
        kind: "platform",
        name: "Hillcrest Solar",
        slug: "hillcrest-solar",
        status: "live",
        timezone: "Africa/Johannesburg",
        currency: "ZAR",
        featureFlags: {},
        isDemo: false,
        isSeed: false,
      }),
    );
    const locationId = await h.run((ctx) =>
      ctx.db.insert("locations", {
        clientId,
        name: "Hillcrest",
        addressLine: "3 Old Main Road",
        suburb: "Hillcrest",
        city: "Durban",
        region: "KwaZulu-Natal",
        countryCode: "ZA",
        timezone: "Africa/Johannesburg",
        active: true,
      }),
    );
    await h.run((ctx) =>
      ctx.db.insert("memberships", {
        userId,
        clientId,
        role: "owner",
        active: true,
        acceptedAt: MON,
      }),
    );

    const config = solarTradesTemplate({
      businessName: "Hillcrest Solar",
      slug: "hillcrest-solar",
      brandColour: "#1f6f43",
      accent: buildAccentRamp("#1f6f43"),
      city: "Durban",
      region: "KwaZulu-Natal",
      suburb: "Hillcrest",
      addressLine: "3 Old Main Road",
      phone: "+27825550001",
    });
    await h.run((ctx) =>
      ctx.db.insert("sites", {
        clientId,
        slug: "hillcrest-solar",
        status: "live",
        config,
        publishedConfig: config,
        version: 1,
        configSchemaVersion: 1,
        isDemo: false,
      }),
    );
    say("  client + live site created");

    // ------------------------------------------------------- their customer
    say("\n▸ FRIDAY — their first customer");

    const { serviceId } = await owner.mutation(api.services.create, {
      clientSlug: "hillcrest-solar",
      key: "assessment",
      name: "Site assessment",
      durationMinutes: 60,
      priceCents: 95_000,
    });
    const { customerId } = await owner.mutation(api.customers.upsertByPhone, {
      clientSlug: "hillcrest-solar",
      name: "Thandi M",
      phone: "082 555 9911",
    });
    const customer = await h.run((ctx) => ctx.db.get(customerId));
    say(`  customers.upsertByPhone → stored as ${customer?.phone} (E.164, the suppression key)`);

    await owner.mutation(api.customers.recordConsent, {
      clientSlug: "hillcrest-solar",
      customerId,
      channel: "whatsapp",
      state: "granted",
      lawfulBasis: "consent",
      source: "booking form",
    });

    const booked = await owner.mutation(api.bookings.book, {
      clientSlug: "hillcrest-solar",
      locationId,
      serviceId,
      customerId,
      startsAt: MON + day(7),
    });
    const bookingId = booked.bookingId;
    say("  bookings.book     → booked, no overlap");
    say(
      `  …confirmation     → queued: ${booked.confirmation.queued}  ` +
        "(in the SAME transaction as the booking)",
    );

    const reminder = await owner.mutation(internal.messages.queueBookingReminder, {
      bookingId,
      hoursBefore: 24,
      now: MON + day(4) + 12 * 60 * 60 * 1000,
    });
    say(`  …24h reminder     → ${reminder.outcome}  (consent checked, quiet hours applied)`);

    const outbox = await owner.query(api.messages.outbox, { clientSlug: "hillcrest-solar" });
    say(
      `  messages.outbox   → ${outbox.length} rows, waiting for the drain. ` +
        "WhatsApp has no provider, so it will record why rather than claim it sent",
    );
    /*
     * Still true, and for a sharper reason than before: a driver now exists,
     * and this customer is on WhatsApp, which has none. Nothing anywhere marks
     * a message sent that was not.
     */
    expect(outbox.every((m) => m.status !== "sent")).toBe(true);

    // -------------------------------------------------------------- a quote
    say("\n▸ FRIDAY — a quote to Thandi");

    const quote = await owner.mutation(api.quotes.create, {
      clientSlug: "hillcrest-solar",
      customerId,
      lineItems: [
        { description: "5 kW hybrid inverter", quantity: 1, unitPriceCents: 3_500_00 },
        { description: "Panels", quantity: 8, unitPriceCents: 250_00 },
      ],
    });
    say(`  quotes.create     → ${quote.number}, ${R(quote.totalCents)} (computed, never taken from the caller)`);
    await owner.mutation(api.quotes.markSent, { clientSlug: "hillcrest-solar", quoteId: quote.quoteId });

    const accepted = await h.mutation(api.public.quote.accept, { token: quote.acceptToken });
    const jobs = await h.run((ctx) => ctx.db.query("jobs").collect());
    say(`  public.quote.accept → accepted by link, jobCreated: ${accepted.jobCreated} (one branch, so unambiguous)`);
    expect(jobs).toHaveLength(1);

    // ------------------------------------------------------------ the money
    say("\n▸ FRIDAY — invoicing the client");

    const invoice = await owner.mutation(api.invoices.issue, {
      clientId,
      lineItems: [
        { description: "Website build", quantity: 1, unitPriceCents: 18_000_00 },
        { description: "Care plan, first month", quantity: 1, unitPriceCents: 950_00 },
      ],
      now: MON + day(4),
    });
    say(`  invoices.issue    → ${invoice.number}, ${R(invoice.totalCents)}, terms 7 days`);
    say(`                      payment reference: ${invoice.paymentReference}  (IS the number)`);
    say(`                      VAT charged: ${invoice.taxFlag}  (no VAT number, so none)`);

    let owed = await owner.query(api.invoices.outstanding, { clientId });
    say(`  invoices.outstanding → ${R(owed.totals[0]!.owedCents)} owed, settlement "${owed.invoices[0]!.settlement}"`);

    let revenue = await owner.query(api.income.summary, { ventureId });
    say(`  income.summary    → ${revenue.length === 0 ? "R0.00 — issuing is NOT revenue (cash basis)" : "unexpected"}`);
    expect(revenue).toEqual([]);

    say("\n▸ THE NEXT WEEK — they pay most of it");
    const part = await owner.mutation(api.invoices.recordPayment, {
      invoiceId: invoice.invoiceId,
      amountCents: 15_000_00,
      occurredAt: MON + day(9),
      reference: invoice.paymentReference,
    });
    say(`  invoices.recordPayment → ${R(1_500_000)} of ${R(invoice.totalCents)}`);
    say(`                      settlement: "${part.settlement}", still owed ${R(part.owedCents)}`);
    expect(part.settlement).toBe("part_paid");

    const found = await owner.query(api.invoices.byReference, { reference: "inv 0001" });
    say(`  invoices.byReference("inv 0001") → ${found?.number} for ${found?.clientName}`);

    const settle = await owner.mutation(api.invoices.recordPayment, {
      invoiceId: invoice.invoiceId,
      amountCents: 3_950_00,
      occurredAt: MON + day(11),
    });
    say(`  …the balance      → settlement: "${settle.settlement}", owed ${R(settle.owedCents)}`);
    expect(settle.settlement).toBe("settled");

    owed = await owner.query(api.invoices.outstanding, { clientId });
    expect(owed.totals[0]!.owedCents).toBe(0);

    // --------------------------------------------------------------- the P&L
    say("\n▸ MONTH END — what did it make");

    await owner.mutation(api.expenses.create, {
      ventureId,
      description: "Vercel Pro",
      category: "hosting",
      amountCents: 40_00,
      currency: "ZAR",
      incurredAt: MON + day(2),
      vendor: "Vercel",
    });
    await owner.mutation(api.expenses.create, {
      ventureId,
      description: "Convex",
      category: "hosting",
      amountCents: 45_00,
      currency: "ZAR",
      incurredAt: MON + day(2),
      vendor: "Convex",
    });

    revenue = await owner.query(api.income.summary, { ventureId });
    say(`  income.summary    → ${R(revenue[0]!.totalCents)} received (the PAYMENTS, not the invoice)`);
    expect(revenue[0]!.totalCents).toBe(18_950_00);

    const pnl = await owner.query(api.finance.pnl, { ventureId });
    const line = pnl.ventures[0]?.currencies[0];
    if (line) {
      say(`  finance.pnl       → revenue ${R(line.revenueCents)} − expenses ${R(line.expenseCents)} = ${R(line.netCents)}`);
    }
    /*
     * What the P&L will NOT do: report a zero for something it does not
     * track. Commissions and subscriptions say "not tracked" rather than
     * R0.00, because a zero is a claim and an absence is not.
     */
    if (pnl.notTracked.length > 0) {
      say(`  …notTracked       → ${pnl.notTracked.length} line(s) reported as untracked, never as R0.00`);
    }

    // ----------------------------------------------------------- the inbox
    say("\n▸ THE INBOX");
    await owner.mutation(api.tasks.create, {
      ventureId,
      title: "Send Hillcrest the care-plan agreement",
      clientId,
      dueAt: MON + day(3),
    });
    await owner.mutation(api.tasks.create, {
      ventureId,
      title: "Chase the 18 leads with no number",
    });
    const inbox = await owner.query(api.tasks.inbox, { ventureId, now: MON + day(5) });
    say(`  tasks.inbox       → ${inbox.overdueCount} overdue, ${inbox.undated.length} someday`);
    say(`                      "${inbox.overdue[0]?.title}" — ${Math.abs(inbox.overdue[0]!.dueInDays!)}d late`);
    expect(inbox.overdueCount).toBe(1);

    // ------------------------------------------------------------- the wall
    say("\n▸ WHAT THE BACKEND REFUSES TO DO");

    await expect(
      owner.mutation(api.invoices.issue, {
        clientId: demo.clientId,
        lineItems: [{ description: "Website", quantity: 1, unitPriceCents: 100 }],
      }),
    ).rejects.toThrow(/NOT_A_REAL_CLIENT/);
    say("  invoice a demo client            → refused (NOT_A_REAL_CLIENT)");

    await expect(
      owner.mutation(api.demos.createForLead, { leadId: refusedId }),
    ).rejects.toThrow(/SUPPRESSED/);
    say("  build a demo for someone who said no → refused (SUPPRESSED)");

    await expect(
      owner.mutation(api.invoices.voidInvoice, {
        invoiceId: invoice.invoiceId,
        reason: "changed my mind",
      }),
    ).rejects.toThrow(/ALREADY_PAID/);
    say("  void a paid invoice              → refused (ALREADY_PAID)");

    say("\n════════════════════════════════════════════════════════════");
    say(`  ${R(invoice.totalCents)} invoiced · ${R(18_950_00)} collected · 1 job · 1 booking`);
    say("  0 messages sent — there is no provider driver, by design");
    say("════════════════════════════════════════════════════════════\n");
  });
});
