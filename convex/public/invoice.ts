import { v, ConvexError } from "convex/values";
import { query } from "../_generated/server";
import { hashToken } from "../lib/tokens";
import { settlementOf, paymentReference } from "../invoices";
import { sumCents, type Currency } from "../lib/money";

/**
 * PUBLIC, UNAUTHENTICATED. On the PUBLIC_ALLOWLIST in guards.test.ts.
 *
 * THE TOKEN IS THE CREDENTIAL, and that is a decision rather than a shortcut.
 *
 * The person who most needs to open an invoice is the client's BOOKKEEPER —
 * somebody who does not work for us, will never have an account here, and
 * whose only relationship with this system is that a document has to reach
 * their filing. Putting a login in front of that means the invoice does not
 * get opened, which means it does not get paid. So the link authorises.
 *
 * Everything about this file follows from that one sentence:
 *
 *   ONE DOCUMENT. A leaked link exposes exactly the invoice it names. No
 *   navigation, no sibling list, no client lookup, no venture, and no ids
 *   returned that could be substituted into anything. `billToName` is
 *   snapshotted ON the invoice precisely so this function never needs to
 *   reach the `clients` table — a join there is how "one document" quietly
 *   stops being true, and a guard test bans one.
 *
 *   THE LEDGER READ IS SCOPED TO THIS INVOICE, by index. It is here because
 *   "has this been paid" is the question a bookkeeper actually has, and
 *   answering it from the ledger rather than a stored flag is the rule the
 *   rest of the money code already follows.
 *
 *   ONE REFUSAL MESSAGE for "no such token" and "wrong token". A distinct
 *   "that invoice exists but your token is wrong" tells a stranger which
 *   guesses are close, which is the only useful signal anybody could extract
 *   from 256 bits of randomness. Same shape as `public/quote.accept`.
 *
 *   REVOKED IS ITS OWN ANSWER, deliberately different. A revoked link was
 *   sent to somebody, so its holder already knows it existed; what they need
 *   told is to ask for a new one, where "not valid" would send them hunting
 *   for a typo instead. Nothing is disclosed that the holder did not have.
 *
 * A VOID INVOICE IS STILL SERVED, marked void. The client is holding a
 * document with a number on it and has to find out it was cancelled;
 * refusing the link leaves them believing it is still payable.
 *
 * WHY THE ISSUER IS JOINED AND THE LEGAL NAME IS NOT.
 *
 * These pull in opposite directions and the split is on purpose. WHO ISSUED
 * IT is history: `issuerLegalName` is snapshotted at issue, so converting to
 * a Pty Ltd next year cannot rewrite the documents already in clients'
 * inboxes. WHERE TO PAY is not history — it is an instruction the reader is
 * about to act on. A snapshotted bank account that has since closed sends a
 * real payment into a dead account, and "the document is a faithful record of
 * what we said in March" is no comfort to either party. So the bank block is
 * read live, and a changed account corrects every unpaid invoice at once.
 *
 * That join is to `issuers` — OUR row, found through the invoice's own
 * venture. It discloses our legal address and bank details, which is what an
 * invoice is for; every one we send carries them to somebody.
 */

const rejected = (message: string) =>
  new ConvexError({ code: "REJECTED", message });

export const view = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const tokenHash = await hashToken(token);

    const invoice = await ctx.db
      .query("invoices")
      .withIndex("by_viewTokenHash", (q) => q.eq("viewTokenHash", tokenHash))
      .unique();

    if (!invoice) throw rejected("that link is not valid");

    if (invoice.viewTokenRevokedAt !== undefined) {
      throw rejected(
        "that link has been withdrawn — ask for a fresh one and this invoice will open again",
      );
    }

    const currency = invoice.currency as Currency;

    const issuer = await ctx.db
      .query("issuers")
      .withIndex("by_venture", (q) => q.eq("ventureId", invoice.ventureId))
      .unique();

    /*
     * Settled from the LEDGER, never from a flag on the row, and scoped to
     * this invoice by index so the read cannot see money belonging to
     * anything else.
     */
    const entries = await ctx.db
      .query("ledgerEntries")
      .withIndex("by_invoice", (q) => q.eq("invoiceId", invoice._id))
      .collect();
    const movements = entries.filter(
      (entry) => entry.type === "payment_received" || entry.type === "refund",
    );
    const paidCents = movements.length === 0 ? 0 : sumCents(movements, currency);

    const money = settlementOf(invoice, paidCents, Date.now());

    /*
     * ASSEMBLED FIELD BY FIELD, never spread. A column added to the invoices
     * table must not become publishable by default — the next person to add
     * one should have to decide, in this file, that a stranger holding a link
     * may see it.
     */
    return {
      number: invoice.number,
      issuedAt: invoice.issuedAt ?? null,
      dueAt: invoice.dueAt ?? null,
      paymentTermsDays: invoice.paymentTermsDays,
      status: invoice.status,

      /** History. Snapshotted at issue and never re-read. */
      issuerLegalName: invoice.issuerLegalName,
      issuerRegistrationNumber: invoice.issuerRegistrationNumber ?? null,
      issuerVatNumber: invoice.issuerVatNumber ?? null,
      billToName: invoice.billToName ?? null,

      /** Instructions. Read live — see the note above. */
      issuer: issuer
        ? {
            tradingName: issuer.tradingName ?? null,
            addressLine: issuer.addressLine,
            suburb: issuer.suburb ?? null,
            city: issuer.city,
            postalCode: issuer.postalCode ?? null,
            countryCode: issuer.countryCode,
            email: issuer.email,
            phone: issuer.phone ?? null,
            /*
             * All four or none. A half-printed bank block is worse than an
             * absent one: somebody transposes an account number from an
             * invoice that never had a branch code and the payment bounces
             * back a week later.
             */
            bank:
              issuer.bankName &&
              issuer.bankAccountName &&
              issuer.bankAccountNumber &&
              issuer.bankBranchCode
                ? {
                    name: issuer.bankName,
                    accountName: issuer.bankAccountName,
                    accountNumber: issuer.bankAccountNumber,
                    branchCode: issuer.bankBranchCode,
                  }
                : null,
          }
        : null,

      currency: invoice.currency,
      lineItems: invoice.lineItems.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        lineTotalCents: Math.round(line.unitPriceCents * line.quantity),
        kind: line.kind,
      })),
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      /** False while unregistered, and then no VAT line renders at all. */
      taxFlag: invoice.taxFlag,

      /*
       * THE REFERENCE IS THE NUMBER. Derived from the same function the rest
       * of the system uses rather than stored, because a second field could
       * be set to something else — and a deposit that reconciles to nothing
       * is not an error anywhere, just money nobody can place.
       */
      paymentReference: paymentReference(invoice.number),

      settlement: money.settlement,
      paidCents: money.paidCents,
      owedCents: money.owedCents,
      creditCents: money.creditCents,
      overdue: money.overdue,
    };
  },
});
