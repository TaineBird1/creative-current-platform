import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * INVOICES.
 *
 * The engine was held behind a guard test on the reasoning that an invoice
 * needs a registered entity. Half right: true of a Pty Ltd, false of a sole
 * proprietor, who invoices in their own name and has nothing to register.
 *
 * What the tests are actually about is the pair of failures that produce a
 * plausible document rather than an error — a duplicate number, and a VAT
 * line from someone who is not registered for VAT.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

const JAN = Date.UTC(2026, 0, 15);

/** A sole proprietor: their own name, no registration number, no VAT number. */
const SOLE_PROP = {
  legalName: "Taine Bird",
  tradingName: "The Creative Current",
  addressLine: "12 Old Main Road",
  suburb: "Hillcrest",
  city: "Durban",
  countryCode: "ZA",
  email: "hello@thecreativecurrent.co.za",
};

async function setup(over: { issuer?: Partial<typeof SOLE_PROP> & { vatNumber?: string } } = {}) {
  const h = harness();
  const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
    email: "owner@thecreativecurrent.co.za",
  });
  const owner = asUser(h, userId);
  const { ventureId } = await owner.mutation(api.ventures.create, {
    name: "Sites",
    type: "platform",
    currency: "ZAR",
  });

  if (over.issuer !== null) {
    await owner.mutation(api.issuer.set, { ventureId, ...SOLE_PROP, ...over.issuer });
  }

  const clientId = await h.run((ctx) =>
    ctx.db.insert("clients", {
      ventureId,
      kind: "external",
      name: "Upper Highway Solar",
      status: "live",
      timezone: "Africa/Johannesburg",
      currency: "ZAR",
      featureFlags: {},
      isDemo: false,
      isSeed: false,
    }),
  );

  return { h, owner, ventureId, clientId };
}

const LINES = [
  { description: "Website build", quantity: 1, unitPriceCents: 1_800_000 },
  { description: "Care plan, first month", quantity: 1, unitPriceCents: 95_000 },
];

describe("a sole proprietor can invoice today", () => {
  test("no registration number is needed, and its absence is not a gap", async () => {
    const s = await setup();
    const result = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId,
      lineItems: LINES,
      now: JAN,
    });

    expect(result.number).toBe("INV-0001");
    expect(result.totalCents).toBe(1_895_000);

    const invoice = await s.owner.query(api.invoices.get, { invoiceId: result.invoiceId });
    expect(invoice?.issuerLegalName).toBe("Taine Bird");
    expect(invoice?.issuerRegistrationNumber).toBeUndefined();
  });

  test("the issuer is read back as a sole proprietor, said rather than inferred", async () => {
    const s = await setup();
    const issuer = await s.owner.query(api.issuer.get, { ventureId: s.ventureId });
    expect(issuer?.isSoleProprietor).toBe(true);
    expect(issuer?.chargesVat).toBe(false);
  });

  test("without an issuer nothing can be invoiced", async () => {
    // An invoice that does not say who issued it is not a document.
    const s = await setup({ issuer: null as never });
    await expect(
      s.owner.mutation(api.invoices.issue, { clientId: s.clientId, lineItems: LINES }),
    ).rejects.toThrow(/NO_ISSUER/);
  });
});

describe("VAT is not charged by someone who is not registered", () => {
  test("no VAT number means no VAT, and taxFlag says so", async () => {
    /*
     * The failure this prevents is not an error — it is a correct-looking
     * invoice with 15% added that the issuer has no right to collect and
     * SARS will want anyway.
     */
    const s = await setup();
    const result = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId,
      lineItems: LINES,
      now: JAN,
    });
    expect(result.taxFlag).toBe(false);
    const invoice = await s.owner.query(api.invoices.get, { invoiceId: result.invoiceId });
    expect(invoice?.taxCents).toBe(0);
    expect(invoice?.totalCents).toBe(invoice?.subtotalCents);
  });

  test("a malformed VAT number is refused rather than printed", async () => {
    // A typo here becomes a VAT line on a real document.
    const s = await setup();
    await expect(
      s.owner.mutation(api.issuer.set, {
        ventureId: s.ventureId,
        ...SOLE_PROP,
        vatNumber: "12345",
      }),
    ).rejects.toThrow(/INVALID_VAT/);
  });

  test("a real VAT number flips the flag, and is snapshotted onto the document", async () => {
    const s = await setup({ issuer: { vatNumber: "4123456789" } });
    const result = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId,
      lineItems: LINES,
      now: JAN,
    });
    expect(result.taxFlag).toBe(true);
    const invoice = await s.owner.query(api.invoices.get, { invoiceId: result.invoiceId });
    expect(invoice?.issuerVatNumber).toBe("4123456789");
  });
});

describe("numbering prefers a gap and never repeats", () => {
  test("numbers run in sequence", async () => {
    const s = await setup();
    const first = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    const second = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    expect([first.number, second.number]).toEqual(["INV-0001", "INV-0002"]);
  });

  test("a rejected invoice burns no number, and none is ever reused", async () => {
    /*
     * Two facts, and the first one is milder than it sounds. Validation runs
     * BEFORE the number is taken, so an ordinary rejection — empty lines, a
     * demo client — costs nothing and leaves no gap. Gaps come from a failure
     * AFTER allocation, which is a whole-transaction rollback and therefore
     * also leaves no gap here.
     *
     * The property that actually has to hold either way is the second one: a
     * number never appears twice. That is what is asserted, because it is the
     * one whose failure cannot be explained to a client.
     */
    const s = await setup();
    await s.owner.mutation(api.invoices.issue, { clientId: s.clientId, lineItems: LINES, now: JAN });

    await expect(
      s.owner.mutation(api.invoices.issue, { clientId: s.clientId, lineItems: [], now: JAN }),
    ).rejects.toThrow(/EMPTY_INVOICE/);

    const third = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });

    const numbers = (await s.h.run((ctx) => ctx.db.query("invoices").collect())).map(
      (row) => row.number,
    );
    expect(new Set(numbers).size, "a number appeared twice").toBe(numbers.length);
    // No gap, because nothing was allocated for the rejected one.
    expect([...numbers].sort()).toEqual(["INV-0001", "INV-0002"]);
    expect(third.number).toBe("INV-0002");
  });

  test("the quote series and the invoice series do not collide", async () => {
    // Both draw from invoiceCounters, keyed by series. A shared counter would
    // make QUO-0003 and INV-0003 the same allocation.
    const s = await setup();
    await s.owner.mutation(api.invoices.issue, { clientId: s.clientId, lineItems: LINES, now: JAN });
    const counters = await s.h.run((ctx) => ctx.db.query("invoiceCounters").collect());
    expect(counters.every((row) => row.series === "INV")).toBe(true);
  });
});

describe("what is owed", () => {
  test("issuing creates a receivable but NOT revenue", async () => {
    /*
     * The P&L is cash basis. Counting the issue AND the payment against it
     * would report every job twice, which is the most flattering possible
     * way to be wrong.
     */
    const s = await setup();
    await s.owner.mutation(api.invoices.issue, { clientId: s.clientId, lineItems: LINES, now: JAN });

    const owed = await s.owner.query(api.invoices.outstanding, { clientId: s.clientId });
    expect(owed.totals[0]?.owedCents).toBe(1_895_000);

    const revenue = await s.owner.query(api.income.summary, { ventureId: s.ventureId });
    expect(revenue).toEqual([]);
  });

  test("a payment settles it, and THEN it is revenue", async () => {
    const s = await setup();
    const { invoiceId } = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });

    const result = await s.owner.mutation(api.invoices.recordPayment, {
      invoiceId, amountCents: 1_895_000, occurredAt: JAN,
    });
    expect(result.settled).toBe(true);

    const owed = await s.owner.query(api.invoices.outstanding, { clientId: s.clientId });
    expect(owed.totals[0]?.owedCents).toBe(0);

    const revenue = await s.owner.query(api.income.summary, { ventureId: s.ventureId });
    expect(revenue.find((row) => row.currency === "ZAR")?.totalCents).toBe(1_895_000);
  });

  test("a PART payment does not mark it paid", async () => {
    // Pretending R500 settled an R18,950 invoice is how a business stops
    // chasing the rest of it.
    const s = await setup();
    const { invoiceId } = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    const result = await s.owner.mutation(api.invoices.recordPayment, {
      invoiceId, amountCents: 50_000, occurredAt: JAN,
    });
    expect(result.settled).toBe(false);
    expect(result.outstandingCents).toBe(1_845_000);

    const invoice = await s.owner.query(api.invoices.get, { invoiceId });
    expect(invoice?.status).toBe("issued");
  });

  test("overdue is derived from today, never stored", async () => {
    const s = await setup();
    await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId,
      lineItems: LINES,
      paymentTermsDays: 0,
      now: Date.now() - 60 * 60 * 1000,
    });
    const owed = await s.owner.query(api.invoices.outstanding, { clientId: s.clientId });
    expect(owed.invoices[0]?.overdue).toBe(true);
    expect(owed.totals[0]?.overdueCents).toBe(1_895_000);
  });
});

describe("an invoice is voided, never deleted", () => {
  test("voiding reverses the receivable and keeps the document", async () => {
    const s = await setup();
    const { invoiceId } = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });

    await s.owner.mutation(api.invoices.voidInvoice, {
      invoiceId, reason: "Issued to the wrong client",
    });

    const owed = await s.owner.query(api.invoices.outstanding, { clientId: s.clientId });
    expect(owed.totals[0]?.owedCents).toBe(0);

    // Still there, still numbered. A vanished invoice looks like a missing
    // one, and an accountant cannot tell those apart from the outside.
    expect(owed.invoices).toHaveLength(1);
    expect(owed.invoices[0]?.status).toBe("void");
    expect(owed.invoices[0]?.number).toBe("INV-0001");
  });

  test("a PAID invoice cannot be voided", async () => {
    // Voiding it would lose the payment. Refund or credit-note instead.
    const s = await setup();
    const { invoiceId } = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    await s.owner.mutation(api.invoices.recordPayment, {
      invoiceId, amountCents: 1_895_000, occurredAt: JAN,
    });
    await expect(
      s.owner.mutation(api.invoices.voidInvoice, { invoiceId, reason: "changed my mind" }),
    ).rejects.toThrow(/ALREADY_PAID/);
  });

  test("voiding needs a reason — it stays on the record", async () => {
    const s = await setup();
    const { invoiceId } = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    await expect(
      s.owner.mutation(api.invoices.voidInvoice, { invoiceId, reason: "   " }),
    ).rejects.toThrow(/INVALID/);
  });
});

describe("what cannot be invoiced", () => {
  test("a demo client", async () => {
    const s = await setup();
    const demoId = await s.h.run((ctx) =>
      ctx.db.insert("clients", {
        ventureId: s.ventureId, kind: "platform", name: "Demo Solar", slug: "demo",
        status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: true, isSeed: false,
      }),
    );
    await expect(
      s.owner.mutation(api.invoices.issue, { clientId: demoId, lineItems: LINES }),
    ).rejects.toThrow(/NOT_A_REAL_CLIENT/);
  });

  test("an invoice with no lines", async () => {
    const s = await setup();
    await expect(
      s.owner.mutation(api.invoices.issue, { clientId: s.clientId, lineItems: [] }),
    ).rejects.toThrow(/EMPTY_INVOICE/);
  });

  test("changing the issuer does not rewrite what was already sent", async () => {
    /*
     * The snapshot rule, checked end to end. Converting to a Pty Ltd next
     * year must not retro-stamp a registration number onto invoices clients
     * are already holding.
     */
    const s = await setup();
    const { invoiceId } = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });

    await s.owner.mutation(api.issuer.set, {
      ventureId: s.ventureId,
      ...SOLE_PROP,
      legalName: "The Creative Current (Pty) Ltd",
      registrationNumber: "2026/123456/07",
    });

    const invoice = await s.owner.query(api.invoices.get, { invoiceId });
    expect(invoice?.issuerLegalName).toBe("Taine Bird");
    expect(invoice?.issuerRegistrationNumber).toBeUndefined();
  });
});

describe("payment terms", () => {
  test("the default is 7 days, not 30", async () => {
    /*
     * Thirty is the corporate default and it is wrong for this business. A
     * one-person agency invoicing small trades does not extend a month of
     * credit, and asking for it teaches a client that late is normal.
     */
    const s = await setup();
    const result = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    expect(result.termsDays).toBe(7);

    const invoice = await s.owner.query(api.invoices.get, { invoiceId: result.invoiceId });
    expect(invoice?.paymentTermsDays).toBe(7);
    expect(invoice?.dueAt).toBe(JAN + 7 * 24 * 60 * 60 * 1000);
  });

  test("it can be overridden per invoice", async () => {
    const s = await setup();
    const result = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, paymentTermsDays: 30, now: JAN,
    });
    const invoice = await s.owner.query(api.invoices.get, { invoiceId: result.invoiceId });
    expect(invoice?.dueAt).toBe(JAN + 30 * 24 * 60 * 60 * 1000);
  });

  test("0 days means on receipt, and is allowed", async () => {
    const s = await setup();
    const result = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, paymentTermsDays: 0, now: JAN,
    });
    const invoice = await s.owner.query(api.invoices.get, { invoiceId: result.invoiceId });
    expect(invoice?.dueAt).toBe(JAN);
  });

  test("nonsense terms are refused", async () => {
    const s = await setup();
    for (const paymentTermsDays of [-1, 2.5, 400]) {
      await expect(
        s.owner.mutation(api.invoices.issue, {
          clientId: s.clientId, lineItems: LINES, paymentTermsDays, now: JAN,
        }),
      ).rejects.toThrow(/INVALID_TERMS/);
    }
  });

  test("the terms are SNAPSHOTTED — changing the default does not re-term what was sent", async () => {
    // Same rule as the issuer. An invoice a client is holding says what was
    // agreed on the day.
    const s = await setup();
    const result = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, paymentTermsDays: 14, now: JAN,
    });
    const invoice = await s.owner.query(api.invoices.get, { invoiceId: result.invoiceId });
    expect(invoice?.paymentTermsDays).toBe(14);
  });
});

describe("the payment reference IS the invoice number", () => {
  /**
   * South African clients pay by EFT, and an unreferenced deposit is the
   * reconciliation problem: money lands with "PAYMENT" or the payer's surname
   * on it and nobody can say which invoice it settled.
   *
   * Derived rather than stored, deliberately. A stored column could be set to
   * something other than the number — which throws nothing, breaks no test,
   * and produces exactly the deposit that reconciles to nothing.
   */
  test("every read carries it, and it always equals the number", async () => {
    const s = await setup();
    const issued = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    expect(issued.paymentReference).toBe(issued.number);

    const invoice = await s.owner.query(api.invoices.get, { invoiceId: issued.invoiceId });
    expect(invoice?.paymentReference).toBe(issued.number);

    const owed = await s.owner.query(api.invoices.outstanding, { clientId: s.clientId });
    expect(owed.invoices[0]?.paymentReference).toBe(issued.number);
  });

  test("there is no stored reference column that could drift from it", async () => {
    // The failure being designed out: two fields that are supposed to agree.
    const s = await setup();
    const { invoiceId } = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    const row = await s.h.run((ctx) => ctx.db.get(invoiceId));
    expect(row).not.toHaveProperty("paymentReference");
  });

  test("a bank statement line finds its invoice", async () => {
    const s = await setup();
    const issued = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    const found = await s.owner.query(api.invoices.byReference, {
      reference: issued.paymentReference,
    });
    expect(found?.invoiceId).toBe(issued.invoiceId);
    expect(found?.clientName).toBe("Upper Highway Solar");
  });

  test("it matches however the client typed it into their banking app", async () => {
    /*
     * "inv 0001", "INV-0001", "inv0001" are one reference. A lookup that only
     * matches a perfectly typed one is a lookup that fails on the day it is
     * needed — which is the day money arrives.
     */
    const s = await setup();
    const issued = await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    for (const typed of ["INV-0001", "inv-0001", "inv 0001", "INV0001", "  inv0001  "]) {
      const found = await s.owner.query(api.invoices.byReference, { reference: typed });
      expect(found?.invoiceId, typed).toBe(issued.invoiceId);
    }
  });

  test("an unknown reference returns nothing rather than a near miss", async () => {
    // Guessing which invoice a stray deposit belongs to is worse than saying
    // it cannot be matched — the wrong invoice gets marked paid.
    const s = await setup();
    await s.owner.mutation(api.invoices.issue, {
      clientId: s.clientId, lineItems: LINES, now: JAN,
    });
    expect(await s.owner.query(api.invoices.byReference, { reference: "INV-0099" })).toBeNull();
    expect(await s.owner.query(api.invoices.byReference, { reference: "" })).toBeNull();
  });
});
