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
export const issue = ownerMutation({
  args: {
    clientId: v.id("clients"),
    lineItems: v.array(lineItem),
    /** Days until due. South African norm is 30; 0 means on receipt. */
    dueInDays: v.optional(v.number()),
    notes: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
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
      issuedAt: now,
      dueAt: now + (args.dueInDays ?? 30) * 24 * 60 * 60 * 1000,
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
      createdBy: ctx.platform.userId,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      action: "invoice.issue",
      entityTable: "invoices",
      entityId: invoiceId,
      ventureId: client.ventureId,
      clientId: args.clientId,
      after: { number, totalCents, currency },
      at: now,
    });

    return { invoiceId, number, totalCents, currency, taxFlag };
  },
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
    if (invoice.status === "paid") {
      throw bad(
        "ALREADY_PAID",
        "That invoice has been paid. Refund it or issue a credit note — voiding a paid invoice loses the payment.",
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

    const paid = await paidAgainst(ctx, args.invoiceId, invoice.currency as Currency);
    const settled = paid >= invoice.totalCents;
    if (settled) {
      await ctx.db.patch(args.invoiceId, { status: "paid", paidAt: args.occurredAt });
    }

    return { settled, paidCents: paid, outstandingCents: Math.max(0, invoice.totalCents - paid) };
  },
});

async function paidAgainst(
  ctx: QueryCtx,
  invoiceId: Id<"invoices">,
  currency: Currency,
): Promise<number> {
  const entries = await ctx.db
    .query("ledgerEntries")
    .withIndex("by_invoice", (q) => q.eq("invoiceId", invoiceId))
    .collect();
  const payments = entries.filter((entry) => entry.type === "payment_received");
  return payments.length === 0 ? 0 : sumCents(payments, currency);
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
        const owed = invoice.status === "void" ? 0 : Math.max(0, invoice.totalCents - paidCents);
        return {
          invoiceId: invoice._id,
          number: invoice.number,
          clientId: invoice.clientId,
          status: invoice.status,
          currency: invoice.currency,
          totalCents: invoice.totalCents,
          paidCents,
          owedCents: owed,
          issuedAt: invoice.issuedAt ?? null,
          dueAt: invoice.dueAt ?? null,
          /** Overdue is a fact about today, so it is derived, never stored. */
          overdue: owed > 0 && invoice.dueAt !== undefined && invoice.dueAt < now,
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
        };
      }),
    };
  },
});

/** One invoice, everything a rendered document needs. */
export const get = platformQuery({
  args: { invoiceId: v.id("invoices") },
  handler: async (ctx, { invoiceId }): Promise<Doc<"invoices"> | null> => ctx.db.get(invoiceId),
});
