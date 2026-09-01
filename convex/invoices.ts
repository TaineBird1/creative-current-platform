import { v, ConvexError } from "convex/values";
import { ownerMutation, platformQuery } from "./lib/functions";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertCents, scaleCents, sumCents, type Currency } from "./lib/money";
import { postEntry, reverseEntry } from "./lib/ledger";

/**
 * INVOICES. The document a client receives.
 *
 * WHAT UNBLOCKED THIS. The ledger has been complete for a while and this was
 * held behind a guard test because an invoice needs a legal name, and there
 * was no registered entity. That reasoning was half wrong: it is true of a
 * Pty Ltd, which takes weeks at CIPC, and NOT true of a sole proprietor, who
 * invoices in their own name and has nothing to register. The schema already
 * had `registrationNumber` optional; the guard did not.
 *
 * NUMBERING PREFERS A GAP.
 *
 * A gap is recoverable — you explain it to an accountant once and the
 * explanation is boring. A DUPLICATE is not: two documents bearing INV-0042
 * sent to two clients, and no way afterwards to say which one a payment
 * settled. So the number is allocated and the invoice inserted in ONE
 * mutation. Convex mutations are serializable, so the counter read-and-patch
 * joins this transaction's read set and two concurrent issues cannot take the
 * same number — one conflicts, retries, and takes the next.
 *
 * THERE IS NO DRAFT INVOICE, and that is what keeps the gaps rare. A draft
 * would have to hold a number to be a draft, and every abandoned one would
 * burn it. The draft already exists and is called a QUOTE: quotes are edited,
 * sent, accepted or declined, and only then does an invoice — numbered,
 * issued, final — come into being.
 *
 * THE ISSUER IS SNAPSHOTTED, NEVER JOINED. A person who changes their trading
 * name, or converts to a Pty Ltd, must not silently rewrite the documents
 * already sitting in clients' inboxes. What was true on the day is what the
 * invoice says forever.
 */

const INVOICE_SERIES = "INV";

/**
 * Seven days, not thirty.
 *
 * Thirty is the corporate default and it is wrong for this business: a
 * one-person agency invoicing small trades does not extend a month of credit,
 * and asking for it teaches a client that late is normal.
 */
const DEFAULT_TERMS_DAYS = 7;

/**
 * THE PAYMENT REFERENCE IS THE INVOICE NUMBER. Not a copy of it.
 *
 * South African clients pay by EFT, and an unreferenced deposit is the
 * reconciliation problem — a payment lands in the bank with "PAYMENT" or the
 * payer's own surname on it and nobody can say which invoice it settled.
 * Every document has to print the reference, plainly, next to the bank
 * details.
 *
 * Derived rather than stored, and that is the whole point. A stored
 * `paymentReference` column could be set to something other than the number,
 * which throws nothing, breaks no test, and produces exactly the deposit that
 * reconciles to nothing. Derived, the two cannot disagree.
 */
export function paymentReference(invoiceNumber: string): string {
  return invoiceNumber;
}
const bad = (code: string, message: string) => new ConvexError({ code, message });

/**
 * Take the next number in the series.
 *
 * Called ONLY from the mutation that inserts the invoice — guards.test.ts
 * fails if any exported function advances a counter without inserting the row
 * that consumes it. Split across two mutations, a failure between them burns
 * a number with no document behind it, and then somebody "tidies up" by
 * reusing it, which is the duplicate this whole design refuses.
 */
async function takeNumber(
  ctx: MutationCtx,
  ventureId: Id<"ventures">,
): Promise<{ number: string; seq: number }> {
  const counter = await ctx.db
    .query("invoiceCounters")
    .withIndex("by_venture_series", (q) =>
      q.eq("ventureId", ventureId).eq("series", INVOICE_SERIES),
    )
    .unique();

  if (!counter) {
    await ctx.db.insert("invoiceCounters", {
      ventureId,
      series: INVOICE_SERIES,
      next: 2,
    });
    return { number: `${INVOICE_SERIES}-0001`, seq: 1 };
  }

  const seq = counter.next;
  await ctx.db.patch(counter._id, { next: seq + 1 });
  return { number: `${INVOICE_SERIES}-${String(seq).padStart(4, "0")}`, seq };
}

/**
 * WHAT IS SETTLED IS DERIVED, NEVER STAMPED.
 *
 * `recordPayment` used to patch the invoice to "paid" once the money covered
 * it. That is a hand-set flag for something the ledger already knows, and the
 * two can come apart: post a refund afterwards and the invoice is still
 * stamped paid, which errors nowhere and reads as settled forever.
 *
 * So there is one function, here, and every read goes through it.
 *
 * A PART PAYMENT IS ITS OWN STATE. R9,000 against R9,500 is not settled and
 * it is not untouched — both of those are wrong in a way that costs money.
 * Read as settled, nobody chases the R500. Read as untouched, the client is
 * chased for R9,500 they have mostly already paid, which is worse: it is the
 * call that ends a relationship.
 *
 * AN OVERPAYMENT LEAVES A CREDIT rather than rounding away. A client who pays
 * R10,000 against R9,500 is owed R500 of work or money, and quietly treating
 * it as "settled, thanks" is keeping money that is not ours.
 */
export type Settlement = "unpaid" | "part_paid" | "settled" | "overpaid" | "void";

export function settlementOf(
  invoice: { totalCents: number; status: string; dueAt?: number },
  paidCents: number,
  now: number,
) {
  const balanceCents = invoice.totalCents - paidCents;

  const settlement: Settlement =
    invoice.status === "void"
      ? "void"
      : paidCents === 0
        ? "unpaid"
        : balanceCents > 0
          ? "part_paid"
          : balanceCents === 0
            ? "settled"
            : "overpaid";

  const owedCents = settlement === "void" ? 0 : Math.max(0, balanceCents);

  return {
    settlement,
    paidCents,
    /** Signed. Negative means we are holding their money. */
    balanceCents: settlement === "void" ? 0 : balanceCents,
    owedCents,
    /** What we owe THEM, when they have overpaid. */
    creditCents: settlement === "void" ? 0 : Math.max(0, -balanceCents),
    /** A fact about today, so it is derived every time and never written down. */
    overdue: owedCents > 0 && invoice.dueAt !== undefined && invoice.dueAt < now,
  };
}

const lineItem = v.object({
  description: v.string(),
  quantity: v.number(),
  unitPriceCents: v.number(),
});

/**
 * Issue an invoice. It exists issued; there is no earlier state.
 *
 * The totals are COMPUTED here and never taken from the caller — a total that
 * disagrees with the lines printed above it is the version a client queries,
 * and the one that costs an afternoon to explain.
 */
/**
 * Issue an invoice. It exists issued; there is no earlier state.
 *
 * The totals are COMPUTED here and never taken from the caller — a total that
 * disagrees with the lines printed above it is the version a client queries,
 * and the one that costs an afternoon to explain.
 *
 * EXPORTED AS A HELPER so the demo seeder produces invoices through this
 * exact code — the numbering, the issuer snapshot, the VAT decision and the
 * ledger entry. A seeder with its own copy would drift from the real thing
 * and, worse, would let you click through a flow that does not exist.
 */
export async function issueInvoice(
  ctx: MutationCtx,
  args: {
    clientId: Id<"clients">;
    lineItems: { description: string; quantity: number; unitPriceCents: number }[];
    paymentTermsDays?: number;
    notes?: string;
    now?: number;
  },
  actorUserId?: Id<"users">,
) {
    const now = args.now ?? Date.now();

    const client = await ctx.db.get(args.clientId);
    if (!client) throw bad("NO_SUCH_CLIENT", "No such client.");

    if (client.isDemo || client.isSeed) {
      throw bad(
        "NOT_A_REAL_CLIENT",
        `${client.name} is ${client.isSeed ? "seed" : "demo"} data. It cannot be invoiced.`,
      );
    }

    const issuer = await ctx.db
      .query("issuers")
      .withIndex("by_venture", (q) => q.eq("ventureId", client.ventureId))
      .unique();

    if (!issuer) {
      throw bad(
        "NO_ISSUER",
        "No issuer is set for this venture. An invoice has to say who is issuing it — set your legal name, address and email first.",
      );
    }

    /*
     * UNCONFIRMED MEANS NOBODY HAS READ IT.
     *
     * An empty issuer field refuses on its own. A plausible one — a name a
     * seed script or a hurried CLI call put there — prints at the top of a
     * document a client keeps, and nothing errors. So the row has to have
     * been looked at by a person, and every edit clears that again.
     */
    if (issuer.confirmedAt === undefined) {
      throw bad(
        "ISSUER_UNCONFIRMED",
        `The issuer for this venture has not been confirmed. Check the details and run issuer.confirm with the legal name — an invoice carries it forever, and a plausible wrong one is worse than none.`,
      );
    }

    if (args.lineItems.length === 0) {
      throw bad("EMPTY_INVOICE", "An invoice with no lines is not a document, it is a number.");
    }

    /*
     * Rounded PER LINE before summing. Summing unrounded and rounding once at
     * the end produces a total that disagrees with the lines printed above
     * it — by a cent, which is exactly the kind of thing a client notices and
     * nobody can explain.
     */
    const currency = client.currency as Currency;
    const lines = args.lineItems.map((line) => {
      const description = line.description.trim();
      if (!description) throw bad("INVALID", "Every line needs a description.");
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        throw bad("INVALID", `"${description}" needs a positive quantity.`);
      }
      return {
        description,
        quantity: line.quantity,
        unitPriceCents: assertCents(line.unitPriceCents, "unitPriceCents"),
        taxable: false,
        kind: "charge" as const,
        lineTotalCents: scaleCents(assertCents(line.unitPriceCents), line.quantity),
      };
    });

    const subtotalCents = sumCents(
      lines.map((line) => ({ amountCents: line.lineTotalCents, currency })),
      currency,
    );

    if (subtotalCents <= 0) {
      throw bad("BAD_MONEY", "An invoice totals more than nothing. Use a credit note instead.");
    }

    /*
     * NO VAT WHILE THERE IS NO VAT NUMBER. Charging VAT without being
     * registered for it is a considerably worse problem than not charging
     * it — the money is not yours and SARS wants it either way. Registration
     * is compulsory only above R1m turnover, so absence is the normal state.
     */
    const taxFlag = Boolean(issuer.vatNumber);
    const taxCents = 0;
    const totalCents = subtotalCents + taxCents;

    const termsDays = args.paymentTermsDays ?? DEFAULT_TERMS_DAYS;
    if (!Number.isInteger(termsDays) || termsDays < 0 || termsDays > 180) {
      throw bad("INVALID_TERMS", "Payment terms are a whole number of days, 0 to 180.");
    }

    const { number, seq } = await takeNumber(ctx, client.ventureId);

    const invoiceId = await ctx.db.insert("invoices", {
      ventureId: client.ventureId,
      clientId: args.clientId,
      number,
      numberSeq: seq,
      currency,
      lineItems: lines.map(({ lineTotalCents, ...line }) => {
        void lineTotalCents;
        return line;
      }),
      subtotalCents,
      taxCents,
      totalCents,
      taxFlag,
      /*
       * SNAPSHOT, not a join. A person who converts to a Pty Ltd next year
       * must not rewrite the invoices already in clients' inboxes.
       */
      issuerLegalName: issuer.legalName,
      issuerRegistrationNumber: issuer.registrationNumber,
      issuerVatNumber: issuer.vatNumber,
      status: "issued",
      paymentTermsDays: termsDays,
      issuedAt: now,
      dueAt: now + termsDays * 24 * 60 * 60 * 1000,
      isDemo: false,
    });

    /*
     * The receivable. NOT revenue — the P&L is cash basis, and counting both
     * the issue and the payment against it would report every job twice. See
     * REVENUE_TYPES in lib/ledger.ts.
     */
    await postEntry(ctx, {
      ventureId: client.ventureId,
      clientId: args.clientId,
      invoiceId,
      type: "invoice_issued",
      amountCents: totalCents,
      currency,
      occurredAt: now,
      description: `${number} — ${client.name}`,
      createdBy: actorUserId,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: actorUserId,
      action: "invoice.issue",
      entityTable: "invoices",
      entityId: invoiceId,
      ventureId: client.ventureId,
      clientId: args.clientId,
      after: { number, totalCents, currency },
      at: now,
    });

    return {
      invoiceId,
      number,
      totalCents,
      currency,
      taxFlag,
      termsDays,
      /*
       * Returned so a caller sending the invoice cannot forget it. It is the
       * number — that is not a coincidence to be preserved, it is the rule.
       */
      paymentReference: paymentReference(number),
    };
}

export const issue = ownerMutation({
  args: {
    clientId: v.id("clients"),
    lineItems: v.array(lineItem),
    /** Payment terms in days. Defaults to 7; 0 means on receipt. */
    paymentTermsDays: v.optional(v.number()),
    notes: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => issueInvoice(ctx, args, ctx.platform.userId),
});

/**
 * Void an invoice. Never delete one.
 *
 * The number stays used and the document stays visible, with a reversing
 * ledger entry beside it. Deleting would leave a gap that looks like a
 * missing invoice rather than a cancelled one, and an accountant cannot tell
 * those apart from the outside.
 */
export const voidInvoice = ownerMutation({
  args: { invoiceId: v.id("invoices"), reason: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw bad("NOT_FOUND", "No such invoice.");
    if (invoice.status === "void") throw bad("ALREADY_VOID", "That invoice is already void.");

    /*
     * ANY money against it, not only a full settlement. Voiding a part-paid
     * invoice orphans the payment: the money is real and in the bank, and the
     * document it belonged to has just claimed it was never owed.
     */
    const paidCents = await paidAgainst(ctx, args.invoiceId, invoice.currency as Currency);
    if (paidCents > 0) {
      throw bad(
        "ALREADY_PAID",
        `${invoice.number} has ${paidCents} cents paid against it. Refund it or issue a credit note — voiding it would orphan that payment.`,
      );
    }

    const reason = args.reason.trim();
    if (!reason) throw bad("INVALID", "Voiding an invoice needs a reason. It stays on the record.");

    const entry = await ctx.db
      .query("ledgerEntries")
      .withIndex("by_invoice", (q) => q.eq("invoiceId", args.invoiceId))
      .first();
    if (entry) await reverseEntry(ctx, entry._id, reason, ctx.platform.userId);

    await ctx.db.patch(args.invoiceId, { status: "void" });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      action: "invoice.void",
      entityTable: "invoices",
      entityId: args.invoiceId,
      ventureId: invoice.ventureId,
      clientId: invoice.clientId,
      before: { status: invoice.status },
      after: { status: "void", reason },
      at: args.now ?? Date.now(),
    });

    return { ok: true as const };
  },
});

/**
 * Record a payment against an invoice.
 *
 * Marks it paid only when the money actually covers it. A part payment is
 * recorded as a part payment: pretending R500 settled an R5,000 invoice is
 * how a business stops chasing the other R4,500.
 */
export const recordPayment = ownerMutation({
  args: {
    invoiceId: v.id("invoices"),
    amountCents: v.number(),
    occurredAt: v.number(),
    reference: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw bad("NOT_FOUND", "No such invoice.");
    if (invoice.status === "void") throw bad("VOID_INVOICE", "That invoice was voided.");

    const amountCents = assertCents(args.amountCents);
    if (amountCents <= 0) throw bad("BAD_MONEY", "A payment is a positive amount.");

    await postEntry(ctx, {
      ventureId: invoice.ventureId,
      clientId: invoice.clientId,
      invoiceId: args.invoiceId,
      type: "payment_received",
      amountCents,
      currency: invoice.currency as Currency,
      occurredAt: args.occurredAt,
      description: `Payment for ${invoice.number}${args.reference ? ` (${args.reference})` : ""}`,
      createdBy: ctx.platform.userId,
    });

    /*
     * NOTHING IS PATCHED. The ledger entry above IS the record that money
     * arrived, and the state of the invoice follows from it — so a refund
     * posted next week moves this back to part_paid on its own, which a
     * stamped flag would not.
     */
    const paidCents = await paidAgainst(ctx, args.invoiceId, invoice.currency as Currency);
    return settlementOf(invoice, paidCents, args.occurredAt);
  },
});

/**
 * NET money against this invoice: what came in, less what went back.
 *
 * Refunds are counted, and the first version did not count them. It summed
 * `payment_received` alone, which meant a settled invoice that was then
 * refunded still read as settled — derived from the wrong set, which has
 * exactly the same effect as the stamped flag it replaced. No error, no red
 * test, and the money is gone.
 *
 * Refunds are already stored negative (lib/ledger.ts refuses them any other
 * way), so this is a plain sum rather than a subtraction with a sign to get
 * wrong.
 */
async function paidAgainst(
  ctx: QueryCtx,
  invoiceId: Id<"invoices">,
  currency: Currency,
): Promise<number> {
  const entries = await ctx.db
    .query("ledgerEntries")
    .withIndex("by_invoice", (q) => q.eq("invoiceId", invoiceId))
    .collect();
  const movements = entries.filter(
    (entry) => entry.type === "payment_received" || entry.type === "refund",
  );
  return movements.length === 0 ? 0 : sumCents(movements, currency);
}

/**
 * WHAT IS OWED — answerable now, and it was not before.
 *
 * A receivable exists because a numbered document went out. Until one could,
 * this returned nothing at all rather than a zero, because a zero is a claim
 * that nothing is owed. Now that invoices exist the figure is real, and it is
 * still computed from the ledger rather than stored: a balance held on a row
 * is a balance that can disagree with its entries.
 *
 * VOID invoices are excluded from what is owed and still listed. A document
 * that vanished when it was cancelled is indistinguishable from one that was
 * never issued, which is the question an accountant is asking.
 */
export const outstanding = platformQuery({
  args: { clientId: v.optional(v.id("clients")), ventureId: v.optional(v.id("ventures")) },
  handler: async (ctx, args) => {
    const all = args.clientId
      ? await ctx.db
          .query("invoices")
          .withIndex("by_client_status", (q) => q.eq("clientId", args.clientId!))
          .collect()
      : await ctx.db.query("invoices").collect();

    const invoices = all.filter((row) =>
      args.ventureId ? row.ventureId === args.ventureId : true,
    );

    const now = Date.now();
    const rows = await Promise.all(
      invoices.map(async (invoice) => {
        const paidCents = await paidAgainst(ctx, invoice._id, invoice.currency as Currency);
        return {
          invoiceId: invoice._id,
          number: invoice.number,
          /** Always the number. Carried so no screen has to remember. */
          paymentReference: paymentReference(invoice.number),
          paymentTermsDays: invoice.paymentTermsDays,
          clientId: invoice.clientId,
          status: invoice.status,
          currency: invoice.currency,
          totalCents: invoice.totalCents,
          issuedAt: invoice.issuedAt ?? null,
          dueAt: invoice.dueAt ?? null,
          ...settlementOf(invoice, paidCents, now),
        };
      }),
    );

    const codes = [...new Set(rows.map((row) => row.currency))].sort();

    return {
      invoices: rows.sort(
        (a, b) =>
          (b.issuedAt ?? 0) - (a.issuedAt ?? 0) ||
          // Unique and sequential, so it is the real issue order rather than
          // the arbitrary-but-stable `_id` the list sorts use elsewhere.
          b.number.localeCompare(a.number),
      ),
      // Per currency, never summed across them.
      totals: codes.map((code) => {
        const forCurrency = rows.filter((row) => row.currency === code);
        return {
          currency: code,
          owedCents: forCurrency.reduce((n, row) => n + row.owedCents, 0),
          overdueCents: forCurrency
            .filter((row) => row.overdue)
            .reduce((n, row) => n + row.owedCents, 0),
          /** Money held that is not ours. Reported, not netted off the debt. */
          creditCents: forCurrency.reduce((n, row) => n + row.creditCents, 0),
        };
      }),
    };
  },
});

/** One invoice, everything a rendered document needs. */
export const get = platformQuery({
  args: { invoiceId: v.id("invoices") },
  handler: async (ctx, { invoiceId }) => {
    const invoice = await ctx.db.get(invoiceId);
    if (!invoice) return null;
    return {
      ...invoice,
      /*
       * Handed to the renderer rather than left for it to work out. The
       * document has to print "Payment reference: INV-0007" beside the bank
       * details, and a template that had to derive it is a template that can
       * print something else.
       */
      paymentReference: paymentReference(invoice.number),
    };
  },
});

/**
 * Find the invoice a deposit belongs to.
 *
 * The other half of the reference existing at all. A bank statement line
 * reads "EFT INV-0007" and this turns that back into the invoice, so
 * reconciliation is a lookup rather than a scroll through a list.
 *
 * Matched case-insensitively and ignoring spaces, because a person typing a
 * reference into their banking app types "inv 0007" as often as not — and a
 * reference that only matches when typed perfectly is a reference that does
 * not work on the day it is needed.
 */
export const byReference = platformQuery({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) => {
    const wanted = reference.replace(/[\s-]/g, "").toUpperCase();
    if (!wanted) return null;

    const all = await ctx.db.query("invoices").collect();
    const match = all.find(
      (invoice) => invoice.number.replace(/[\s-]/g, "").toUpperCase() === wanted,
    );
    if (!match) return null;

    const client = await ctx.db.get(match.clientId);
    return {
      invoiceId: match._id,
      number: match.number,
      clientId: match.clientId,
      clientName: client?.name ?? "Unknown client",
      status: match.status,
      totalCents: match.totalCents,
      currency: match.currency,
      dueAt: match.dueAt ?? null,
    };
  },
});
