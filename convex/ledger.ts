import { v, ConvexError } from "convex/values";
import { ownerMutation, platformQuery } from "./lib/functions";
import { currency } from "./tables/tenants";
import { assertCents, sumCents, type Currency } from "./lib/money";
import { postEntry, isRevenue } from "./lib/ledger";
import { byDesc } from "./lib/ordering";

/**
 * THE LEDGER, READ.
 *
 * `income.ts` records the ordinary case and this file covers the rest: money
 * that went back out, and the per-client view of what actually moved.
 *
 * A NOTE ON WHAT THIS IS NOT. There is no `outstanding`, no `aging` and no
 * "what does this client owe me", and their absence is deliberate rather than
 * unfinished. A debt exists because a customer was sent a numbered document
 * with a legal name and a registration number on it. There is no registered
 * entity behind this platform yet, so nothing has been issued, so nothing is
 * owed — and a receivables screen returning R0 would be a claim about the
 * world rather than a gap in the data. See the note at the foot of
 * lib/ledger.ts, and the guard in guards.test.ts that holds the boundary.
 *
 * What IS here is true today: money received, money refunded, and the net,
 * per client and per currency, never summed across currencies.
 */

/**
 * Money that went back to a customer.
 *
 * Stored NEGATIVE, and the choke point refuses it any other way. A refund
 * recorded positive does not error anywhere downstream — it reads as revenue,
 * so a month in which you refunded R10,000 reports R10,000 better than a
 * month in which nothing happened.
 *
 * It reduces revenue rather than counting as an expense, because that is what
 * it is: the sale partly did not happen. Filing it as a cost would leave the
 * revenue line claiming income you gave back.
 */
export const refund = ownerMutation({
  args: {
    ventureId: v.id("ventures"),
    clientId: v.optional(v.id("clients")),
    /**
     * The invoice this reverses, when it reverses one. Naming it is what
     * moves that invoice back off "settled" — a refund recorded against the
     * client alone leaves the document still reading as paid in full.
     */
    invoiceId: v.optional(v.id("invoices")),
    /** Positive here, for the person typing it. Negated before it is stored. */
    amountCents: v.number(),
    currency,
    occurredAt: v.number(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const amountCents = assertCents(args.amountCents);
    if (amountCents <= 0) {
      throw new ConvexError({
        code: "BAD_MONEY",
        message:
          "Enter the refund as a positive amount — it is stored negative. A negative here would cancel out and record income.",
      });
    }

    const entryId = await postEntry(ctx, {
      ventureId: args.ventureId,
      clientId: args.clientId,
      invoiceId: args.invoiceId,
      type: "refund",
      amountCents: -amountCents,
      currency: args.currency,
      occurredAt: args.occurredAt,
      description: args.description,
      createdBy: ctx.platform.userId,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      action: "ledger.refund",
      entityTable: "ledgerEntries",
      entityId: entryId,
      ventureId: args.ventureId,
      clientId: args.clientId,
      after: { amountCents: -amountCents, currency: args.currency },
      at: Date.now(),
    });

    return { entryId, amountCents: -amountCents, currency: args.currency };
  },
});

/**
 * One client's ledger, per currency.
 *
 * `received` and `refunded` are reported separately and the net is given
 * beside them, rather than a single figure. A client who paid R50,000 and was
 * refunded R20,000 is a different relationship from one who paid R30,000, and
 * a lone net of R30,000 cannot tell you which you are looking at.
 */
export const forClient = platformQuery({
  args: { clientId: v.id("clients"), since: v.optional(v.number()), until: v.optional(v.number()) },
  handler: async (ctx, { clientId, since, until }) => {
    const client = await ctx.db.get(clientId);
    if (!client) {
      throw new ConvexError({ code: "NO_SUCH_CLIENT", message: "No such client." });
    }

    const rows = (
      await ctx.db
        .query("ledgerEntries")
        .withIndex("by_client_occurred", (q) => q.eq("clientId", clientId))
        .collect()
    )
      .filter((row) => since === undefined || row.occurredAt >= since)
      .filter((row) => until === undefined || row.occurredAt <= until);

    const codes = [...new Set(rows.map((row) => row.currency))].sort() as Currency[];

    return {
      clientName: client.name,
      /*
       * Reversals stay in the statement. An entry that vanished when it was
       * corrected would leave a reader unable to tell a mistake from a
       * change of mind, and the correction is often the interesting part.
       */
      entries: rows.sort(byDesc((row) => row.occurredAt)).map((row) => ({
        _id: row._id,
        type: row.type,
        description: row.description,
        amountCents: row.amountCents,
        currency: row.currency,
        occurredAt: row.occurredAt,
        isReversal: row.reversesEntryId !== undefined,
      })),
      totals: codes.map((code) => {
        const forCurrency = rows.filter((row) => row.currency === code);
        const received = forCurrency.filter((row) => row.type === "payment_received");
        const refunded = forCurrency.filter((row) => row.type === "refund");
        return {
          currency: code,
          receivedCents: sumCents(received, code),
          // Already negative in the ledger; reported as a positive magnitude
          // so the screen does not have to decide how to render a minus sign.
          refundedCents: -sumCents(refunded, code),
          netCents: sumCents(forCurrency.filter((row) => isRevenue(row.type)), code),
        };
      }),
      /*
       * Said out loud rather than left to be inferred from a missing field.
       * A console that shows totals with no mention of receivables invites
       * the reader to assume the net IS what they are owed.
       */
      receivables: "not tracked — no invoice has ever been issued" as const,
    };
  },
});
