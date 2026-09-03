import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { tenantQuery, tenantMutation } from "./lib/functions";
import { queueQuoteSentFor } from "./messages";
import { quoteLink } from "./lib/links";
import type { DispatchResult } from "./lib/messaging";
import { assertOwned, auditWrite, type TenantContext } from "./lib/tenancy";
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
      // _creationTime is safe HERE and only here: a quote comes into existence
      // when it is written, so write order IS the event order. It is unique,
      // so there is nothing to tie-break. Do not copy this to a list whose
      // rows record something that happened away from the keyboard.
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

/**
 * Everything both send paths must be true of, in one place.
 *
 * Both act only on a DRAFT, and that is what keeps them from treading on each
 * other: once a quote is `sent`, neither can run, so a link already in a
 * customer's hands can never be invalidated by the other route being taken
 * afterwards.
 */
async function assertSendable(
  ctx: MutationCtx,
  tenant: TenantContext,
  quoteId: Id<"quotes">,
) {
  const quote = assertOwned(tenant, await ctx.db.get(quoteId));
  if (quote.status !== "draft") {
    throw new ConvexError({
      code: "NOT_A_DRAFT",
      message: `${quote.number} has already gone out.`,
    });
  }
  if (quote.expiresAt < Date.now()) {
    throw new ConvexError({
      code: "ALREADY_EXPIRED",
      message: `${quote.number} expired before it went out. Issue a new one.`,
    });
  }
  return quote;
}

/**
 * RECORD THAT THE CLIENT HANDED THE QUOTE OVER THEMSELVES.
 *
 * Renamed from `send`, which is the whole point of the change. It never sent
 * anything: it set a status and wrote an audit row, so a quote could sit at
 * `sent` having reached nobody, and the screen, the list and the audit trail
 * would all agree it had gone out. A name that asserts something the function
 * does not do is the failure this codebase refuses everywhere else — the no-op
 * driver that returns success, the outbox that must never say delivered.
 *
 * This is the honest version and it has a real use: the client copies the
 * accept link into their own WhatsApp thread, which is how this business
 * actually works, and then tells the system they did. `sendToCustomer` below
 * is the path that genuinely dispatches.
 */
export const markSent = tenantMutation("staff")({
  args: { quoteId: v.id("quotes") },
  handler: async (ctx, { quoteId }): Promise<{ quoteId: Id<"quotes">; number: string }> => {
    const quote = await assertSendable(ctx, ctx.tenant, quoteId);

    await ctx.db.patch(quoteId, { status: "sent" });
    await auditWrite(ctx, ctx.tenant, {
      action: "quote.markSent",
      entityTable: "quotes",
      entityId: quoteId,
      after: { status: "sent", by: "hand" },
    });

    return { quoteId, number: quote.number };
  },
});

/**
 * ACTUALLY SEND IT, through the outbox.
 *
 * IT MINTS A FRESH TOKEN, and that is unavoidable rather than careless: the
 * plaintext from `create` is returned once and stored nowhere, so nothing can
 * reconstruct the link later. Re-minting is the only way to build a message
 * that contains one.
 *
 * The consequence — any link `create` already produced stops working — is
 * contained by `assertSendable`: both paths require a DRAFT, so this cannot
 * run on a quote whose link has already been handed over and marked sent. The
 * screen marks a manual handover as sent for exactly that reason.
 *
 * THE OUTCOME IS RETURNED, not assumed. `dispatch` refuses demo and seed data,
 * a recipient that resolves to a lead, a customer with no consent and one with
 * nowhere to send to — all of them correct, all of them meaning the customer
 * heard nothing. The caller is told which, while they can still act on it,
 * rather than discovering it in the outbox next week. Same reasoning as
 * `book` returning its confirmation outcome.
 *
 * The status moves to `sent` REGARDLESS, because the client did send it: the
 * quote is no longer a draft they are working on. Whether it reached anybody
 * is the outbox's question and it answers it honestly.
 */
export const sendToCustomer = tenantMutation("staff")({
  args: { quoteId: v.id("quotes") },
  handler: async (
    ctx,
    { quoteId },
  ): Promise<{
    quoteId: Id<"quotes">;
    number: string;
    /** What the messaging pipeline decided. See DispatchResult. */
    outcome: string;
    /** Plain-language, for a person who is standing there now. */
    notice: string | null;
  }> => {
    const quote = await assertSendable(ctx, ctx.tenant, quoteId);

    /*
     * A NEW TOKEN, and the old hash is replaced in the same transaction that
     * queues the message carrying the new one. There is no window in which a
     * link exists that the database will not recognise.
     */
    const token = newInviteToken();
    await ctx.db.patch(quoteId, {
      status: "sent",
      acceptTokenHash: await hashToken(token),
    });

    const now = Date.now();
    const result = await queueQuoteSentFor(ctx, {
      quoteId,
      acceptToken: token,
      // The client is standing here having just pressed send, so they
      // witnessed it — which is what lets this interrupt quiet hours for an
      // hour, and no longer.
      triggeredAt: now,
      now,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "quote.sendToCustomer",
      entityTable: "quotes",
      entityId: quoteId,
      after: { status: "sent", by: "outbox", outcome: result.outcome },
    });

    return {
      quoteId,
      number: quote.number,
      outcome: result.outcome,
      notice: describeDispatch(result),
    };
  },
});

/**
 * The sentence a person needs, or null when nothing needs saying.
 *
 * Null for a queued message on purpose: "it worked" is what the absence of a
 * warning already means, and a notice for the ordinary case trains people to
 * dismiss the ones that matter.
 */
function describeDispatch(result: DispatchResult): string | null {
  switch (result.outcome) {
    case "queued":
      return result.held
        ? "Queued. It will go out in the morning — it is quiet hours where this customer is."
        : null;
    case "duplicate":
      return "That quote had already been sent to this customer, so nothing was sent twice.";
    case "suppressed_demo":
      return "This is demo or seed data, so nothing was sent.";
    case "suppressed_consent":
      return "Nothing was sent: this customer has not agreed to be contacted, or asked us to stop.";
    case "suppressed_lead":
      return `Nothing was sent — ${result.reason}`;
    case "no_destination":
      return "Nothing was sent: there is no email address or usable number on this customer. Send them the link yourself.";
    default:
      return null;
  }
}

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

/**
 * MINT A FRESH ACCEPT LINK FOR A QUOTE ALREADY SENT.
 *
 * "Sent" was a one-way door before this. `sendToCustomer` requires a draft and
 * the plaintext token is returned once and stored nowhere, so the moment a
 * quote left the back office there was no way back to its link — and the
 * things that put you there are all week-one ordinary: the customer deleted
 * the email, it went to spam, they changed phones, or the client wants to read
 * the address down the phone while the customer is on the line.
 *
 * The only remaining option was to build the whole quote again under a new
 * number, which loses the thread and puts two documents for one job in front
 * of a customer.
 *
 * THE OLD LINK STOPS WORKING, and that is the honest behaviour rather than a
 * limitation. There is one `acceptTokenHash`, so minting replaces it. Two live
 * links to one document is two things to remember to revoke, and the second is
 * the one nobody remembers.
 *
 * IT DOES NOT SEND. `resendToCustomer` below does that, deliberately separate:
 * minting a link is what you do to read it down a phone, and a function that
 * emailed as a side effect would be a second message to a customer who is
 * already talking to you.
 */
export const reissueAcceptLink = tenantMutation("staff")({
  args: { quoteId: v.id("quotes") },
  handler: async (
    ctx,
    { quoteId },
  ): Promise<{ quoteId: Id<"quotes">; number: string; acceptUrl: string }> => {
    const quote = assertOwned(ctx.tenant, await ctx.db.get(quoteId));

    if (quote.status === "accepted") {
      throw new ConvexError({
        code: "ALREADY_ACCEPTED",
        message: `${quote.number} has been accepted. There is nothing left to agree to.`,
      });
    }
    if (quote.status === "declined") {
      throw new ConvexError({
        code: "WITHDRAWN",
        message: `${quote.number} was withdrawn. Build a new quote instead.`,
      });
    }
    if (quote.expiresAt < Date.now()) {
      throw new ConvexError({
        code: "EXPIRED",
        message: `${quote.number} expired on its own terms. Build a new one — the price has moved.`,
      });
    }

    const token = newInviteToken();
    await ctx.db.patch(quoteId, {
      acceptTokenHash: await hashToken(token),
      acceptLinkResends: (quote.acceptLinkResends ?? 0) + 1,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "quote.reissueAcceptLink",
      entityTable: "quotes",
      entityId: quoteId,
      after: { resends: (quote.acceptLinkResends ?? 0) + 1 },
    });

    return { quoteId, number: quote.number, acceptUrl: quoteLink(token) };
  },
});

/**
 * SEND IT AGAIN, on a fresh link.
 *
 * A NEW IDEMPOTENCY KEY, carried by the resend ordinal — see
 * `idempotencyKeyFor`. Without it the outbox would refuse this as a duplicate
 * of the original send, which is the silent failure that matters most here: a
 * customer says they never got the quote, the client presses send, and the
 * system decides on their behalf that they did.
 *
 * The standing preference settles the cost. A quote arriving twice is mildly
 * annoying. One that never arrives is a job that goes to whoever did answer.
 */
export const resendToCustomer = tenantMutation("staff")({
  args: { quoteId: v.id("quotes") },
  handler: async (
    ctx,
    { quoteId },
  ): Promise<{
    quoteId: Id<"quotes">;
    number: string;
    outcome: string;
    notice: string | null;
  }> => {
    const quote = assertOwned(ctx.tenant, await ctx.db.get(quoteId));

    if (quote.status === "draft") {
      throw new ConvexError({
        code: "NOT_SENT_YET",
        message: `${quote.number} has not gone out once yet.`,
      });
    }
    if (quote.status === "accepted") {
      throw new ConvexError({
        code: "ALREADY_ACCEPTED",
        message: `${quote.number} has been accepted already.`,
      });
    }
    if (quote.status === "declined") {
      throw new ConvexError({
        code: "WITHDRAWN",
        message: `${quote.number} was withdrawn. Build a new quote instead.`,
      });
    }
    if (quote.expiresAt < Date.now()) {
      throw new ConvexError({
        code: "EXPIRED",
        message: `${quote.number} has expired. Build a new one rather than re-sending a dead price.`,
      });
    }

    const resend = (quote.acceptLinkResends ?? 0) + 1;
    const token = newInviteToken();
    await ctx.db.patch(quoteId, {
      acceptTokenHash: await hashToken(token),
      acceptLinkResends: resend,
    });

    const now = Date.now();
    const result = await queueQuoteSentFor(ctx, {
      quoteId,
      acceptToken: token,
      resend,
      triggeredAt: now,
      now,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "quote.resendToCustomer",
      entityTable: "quotes",
      entityId: quoteId,
      after: { resend, outcome: result.outcome },
    });

    return {
      quoteId,
      number: quote.number,
      outcome: result.outcome,
      notice: describeDispatch(result),
    };
  },
});
