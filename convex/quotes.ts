import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { tenantQuery, tenantMutation } from "./lib/functions";
import { assertOwned, auditWrite } from "./lib/tenancy";
import { assertCents } from "./lib/money";
import { hashToken, newInviteToken } from "./lib/invites";

/**
 * QUOTES — priced work, sent to a customer, accepted by a link.
 *
 * Distinct from `quoteRequests`, which is what the CUSTOMER sent before
 * anyone priced anything. This is the answer to one of those.
 *
 * Totals are COMPUTED here and never accepted from the caller. A client that
 * can post its own total is a client that can post any total, and the number
 * on the PDF the customer accepted has to be the number the ledger later
 * bills. Line maths is the one place that must agree with itself.
 *
 * The accept link is a bearer token: whoever holds it can accept. It is
 * therefore stored HASHED, exactly like an invite, and the plaintext is
 * returned once at creation and never again — the same reasoning as a
 * password reset link, and for the same reason a database leak must not hand
 * an attacker the ability to accept work on a customer's behalf.
 *
 * TAX IS NOT IMPLEMENTED, deliberately. Line items carry `taxable` and the
 * schema has `subtotalCents` and `totalCents`, but nothing anywhere stores a
 * tax posture — no registration flag, no rate. The business is not VAT
 * registered, so today total === subtotal and no VAT line exists, which is
 * correct. When registration happens the flag needs a home in the schema
 * first; computing a rate from a constant in this file would put a tax figure
 * on a customer document that no record justifies.
 */

const QUOTE_SERIES = "QUO";

export type QuoteLine = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
};

export type QuoteRow = {
  _id: Id<"quotes">;
  number: string;
  status: "draft" | "sent" | "accepted" | "declined" | "expired";
  customerId: Id<"customers">;
  customerName: string;
  lineItems: QuoteLine[];
  subtotalCents: number;
  totalCents: number;
  currency: "ZAR" | "USD" | "EUR" | "GBP" | "NAD" | "BWP";
  expiresAt: number;
  acceptedAt: number | null;
  /** Derived, not stored: a stored "expired" would need a cron to stay true. */
  isExpired: boolean;
  isDemo: boolean;
};

/**
 * Line maths, in one place. Quantity is allowed to be fractional (2.5 hours,
 * 1.75 metres) but the MONEY is not: each line is rounded to whole cents
 * before it is summed, so the total is the sum of what the customer sees on
 * each line rather than a differently-rounded figure that disagrees with it.
 */
export function lineTotals(lines: readonly QuoteLine[]): {
  subtotalCents: number;
  totalCents: number;
} {
  let subtotalCents = 0;
  for (const line of lines) {
    assertCents(line.unitPriceCents, "unitPriceCents");
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new ConvexError({
        code: "INVALID_QUANTITY",
        message: `"${line.description}" needs a quantity greater than zero.`,
      });
    }
    subtotalCents += Math.round(line.unitPriceCents * line.quantity);
  }
  assertCents(subtotalCents, "subtotalCents");
  // No tax posture exists, so the total IS the subtotal. See the module note.
  return { subtotalCents, totalCents: subtotalCents };
}

async function nextNumber(ctx: MutationCtx, ventureId: Id<"ventures">): Promise<string> {
  const counter = await ctx.db
    .query("invoiceCounters")
    .withIndex("by_venture_series", (q) =>
      q.eq("ventureId", ventureId).eq("series", QUOTE_SERIES),
    )
    .unique();

  if (!counter) {
    await ctx.db.insert("invoiceCounters", { ventureId, series: QUOTE_SERIES, next: 2 });
    return `${QUOTE_SERIES}-0001`;
  }

  /*
   * Read-then-increment inside the mutation. The read joins the transaction's
   * read set, so two quotes created at once conflict and one retries rather
   * than both taking the same number. Numbers must never collide: a customer
   * accepting "QUO-0007" must be accepting exactly one document.
   */
  await ctx.db.patch(counter._id, { next: counter.next + 1 });
  return `${QUOTE_SERIES}-${String(counter.next).padStart(4, "0")}`;
}

const DEFAULT_VALID_DAYS = 14;

export const list = tenantQuery("staff")({
  args: {
    status: v.optional(
      v.union(
        v.literal("draft"),
        v.literal("sent"),
        v.literal("accepted"),
        v.literal("declined"),
        v.literal("expired"),
      ),
    ),
  },
  handler: async (ctx, { status }): Promise<QuoteRow[]> => {
    const rows = status
      ? await ctx.db
          .query("quotes")
          .withIndex("by_client_status", (q) =>
            q.eq("clientId", ctx.tenant.clientId).eq("status", status),
          )
          .collect()
      : await ctx.db
          .query("quotes")
          .withIndex("by_client_status", (q) => q.eq("clientId", ctx.tenant.clientId))
          .collect();

    const customers = new Map(
      (
        await ctx.db
          .query("customers")
          .withIndex("by_client_phone", (q) => q.eq("clientId", ctx.tenant.clientId))
          .collect()
      ).map((doc) => [doc._id, doc]),
    );

    const now = Date.now();
    return rows
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((row) => ({
        _id: row._id,
        number: row.number,
        status: row.status,
        customerId: row.customerId,
        customerName: customers.get(row.customerId)?.name ?? "Unknown customer",
        lineItems: row.lineItems,
        subtotalCents: row.subtotalCents,
        totalCents: row.totalCents,
        currency: row.currency,
        expiresAt: row.expiresAt,
        acceptedAt: row.acceptedAt ?? null,
        /*
         * Derived rather than stored. A stored "expired" is only true until
         * the next minute and needs a cron to stay honest; a comparison is
         * true whenever anyone looks.
         */
        isExpired: row.status !== "accepted" && row.expiresAt < now,
        isDemo: row.isDemo,
      }));
  },
});

export const create = tenantMutation("manager")({
  args: {
    customerId: v.id("customers"),
    lineItems: v.array(
      v.object({
        description: v.string(),
        quantity: v.number(),
        unitPriceCents: v.number(),
        taxable: v.optional(v.boolean()),
      }),
    ),
    validDays: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    quoteId: Id<"quotes">;
    number: string;
    totalCents: number;
    /** Plaintext, returned ONCE. Only the hash is stored. */
    acceptToken: string;
  }> => {
    const customer = assertOwned(ctx.tenant, await ctx.db.get(args.customerId));
    if (customer.mergedIntoId) {
      throw new ConvexError({
        code: "CUSTOMER_MERGED",
        message: "That customer record was merged. Quote the surviving record.",
      });
    }

    if (args.lineItems.length === 0) {
      throw new ConvexError({
        code: "EMPTY_QUOTE",
        message: "A quote needs at least one line. Send a message instead.",
      });
    }

    const lineItems: QuoteLine[] = args.lineItems.map((line) => {
      const description = line.description.trim();
      if (!description) {
        throw new ConvexError({
          code: "INVALID",
          message: "Every line needs a description — the customer is agreeing to it.",
        });
      }
      return {
        description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        taxable: line.taxable ?? false,
      };
    });

    const { subtotalCents, totalCents } = lineTotals(lineItems);

    const client = await ctx.db.get(ctx.tenant.clientId);
    if (!client) throw new ConvexError({ code: "NOT_FOUND", message: "No such client." });

    const validDays = args.validDays ?? DEFAULT_VALID_DAYS;
    if (!Number.isInteger(validDays) || validDays <= 0) {
      throw new ConvexError({
        code: "INVALID",
        message: "A quote has to be valid for at least a day.",
      });
    }

    const token = newInviteToken();
    const number = await nextNumber(ctx, client.ventureId);

    const quoteId = await ctx.db.insert("quotes", {
      clientId: ctx.tenant.clientId,
      customerId: args.customerId,
      number,
      lineItems,
      subtotalCents,
      totalCents,
      currency: client.currency,
      status: "draft",
      expiresAt: Date.now() + validDays * 24 * 60 * 60 * 1000,
      acceptTokenHash: await hashToken(token),
      isDemo: client.isDemo,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "quote.create",
      entityTable: "quotes",
      entityId: quoteId,
      after: { number, totalCents, lines: lineItems.length },
    });

    return { quoteId, number, totalCents, acceptToken: token };
  },
});

export const send = tenantMutation("staff")({
  args: { quoteId: v.id("quotes") },
  handler: async (ctx, { quoteId }): Promise<{ quoteId: Id<"quotes">; number: string }> => {
    const quote = assertOwned(ctx.tenant, await ctx.db.get(quoteId));
    if (quote.status !== "draft") {
      throw new ConvexError({
        code: "NOT_A_DRAFT",
        message: `${quote.number} has already been sent.`,
      });
    }
    if (quote.expiresAt < Date.now()) {
      throw new ConvexError({
        code: "ALREADY_EXPIRED",
        message: `${quote.number} expired before it was sent. Issue a new one.`,
      });
    }

    await ctx.db.patch(quoteId, { status: "sent" });
    await auditWrite(ctx, ctx.tenant, {
      action: "quote.send",
      entityTable: "quotes",
      entityId: quoteId,
      after: { status: "sent" },
    });

    return { quoteId, number: quote.number };
  },
});

export const decline = tenantMutation("staff")({
  args: { quoteId: v.id("quotes") },
  handler: async (ctx, { quoteId }): Promise<{ quoteId: Id<"quotes"> }> => {
    const quote = assertOwned(ctx.tenant, await ctx.db.get(quoteId));
    if (quote.status === "accepted") {
      throw new ConvexError({
        code: "ALREADY_ACCEPTED",
        message: `${quote.number} was accepted. Cancel the job instead.`,
      });
    }
    await ctx.db.patch(quoteId, { status: "declined" });
    await auditWrite(ctx, ctx.tenant, {
      action: "quote.decline",
      entityTable: "quotes",
      entityId: quoteId,
      before: { status: quote.status },
      after: { status: "declined" },
    });
    return { quoteId };
  },
});
