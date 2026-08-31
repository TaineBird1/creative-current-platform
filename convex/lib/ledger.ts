import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { assertCents, type Currency } from "./money";

/**
 * THE LEDGER CHOKE POINT.
 *
 * Every row in `ledgerEntries` is written here and nowhere else, enforced by
 * guards.test.ts. Same reasoning as dispatch() for messages: the rules below
 * are only rules if there is one place to break.
 *
 * The rules, and what each one is actually preventing:
 *
 *   WHOLE CENTS. A stray divide puts 3333.333333 in a ledger and every total
 *   downstream is wrong by a fraction that never reconciles.
 *
 *   NEVER ZERO. A zero entry is not a fact about money. It is almost always a
 *   half-built form or an amount that failed to parse, and it makes a
 *   statement longer without making it truer.
 *
 *   THE SIGN MUST MATCH THE TYPE. A `refund` stored positive inflates revenue
 *   by twice the refund; a `payment_received` stored negative is a refund
 *   wearing the wrong label, and a P&L built on either is confidently wrong.
 *   This is the check most worth having, because both mistakes produce a
 *   plausible-looking number rather than an error.
 *
 *   THE CLIENT MUST BELONG TO THE VENTURE. Otherwise money lands in a P&L it
 *   was never earned in, and the venture it belongs to looks unprofitable.
 *
 *   DEMO AND SEED DATA NEVER ACCRUES. A demo site exists to be clicked
 *   through by a stranger. Money against it is not money.
 *
 * APPEND-ONLY. There is no patch and no delete — guards.test.ts fails on
 * either. A mistake is corrected by `reverseEntry`, which writes an opposing
 * row and leaves both visible. That is what an immutable ledger means in
 * practice: the wrong number stays, with its correction beside it, because an
 * edit that erases it also erases the evidence that it happened.
 */

/**
 * WHAT COUNTS AS REVENUE — defined once, here.
 *
 * It was previously duplicated in income.ts and finance.ts, with a comment in
 * income.ts worrying about exactly the drift that implies: a type recorded by
 * one and missed by the other is money that exists in the ledger and never
 * reaches a P&L. Both now import this.
 *
 * The basis is CASH, deliberately. `invoice_issued` is absent because issuing
 * an invoice is not being paid — counting both it and the payment against it
 * would report every job twice. Receivables are a separate question that this
 * codebase cannot answer yet; see the note at the bottom of this file.
 */
export const REVENUE_TYPES = [
  "payment_received",
  "property_income",
  "refund",
  "adjustment",
] as const;

/** What reduces the net. Expenses have their own table; these are ledger-side. */
export const COST_TYPES = ["expense", "commission_paid", "write_off"] as const;

export const isRevenue = (type: string): boolean =>
  (REVENUE_TYPES as readonly string[]).includes(type);

/**
 * The sign a type must carry. Positive is money toward us.
 * `null` means either sign is legitimate — an adjustment is a correction and
 * corrections go both ways, which is the whole point of having the type.
 */
/*
 * Derived from the schema, never re-typed by hand. Adding a type to the table
 * without deciding its sign is then a compile error rather than a row that
 * silently skips the check below.
 */
export type LedgerType = Doc<"ledgerEntries">["type"];

const REQUIRED_SIGN: Record<LedgerType, 1 | -1 | null> = {
  invoice_issued: 1,
  payment_received: 1,
  property_income: 1,
  commission_accrued: 1,
  refund: -1,
  credit_note: -1,
  write_off: -1,
  commission_paid: -1,
  expense: -1,
  adjustment: null,
};

export type PostInput = {
  ventureId: Id<"ventures">;
  clientId?: Id<"clients">;
  invoiceId?: Id<"invoices">;
  type: LedgerType;
  amountCents: number;
  currency: Currency;
  occurredAt: number;
  description: string;
  reversesEntryId?: Id<"ledgerEntries">;
  createdBy?: Id<"users">;
  impersonationSessionId?: Id<"impersonationSessions">;
};

const bad = (code: string, message: string) => new ConvexError({ code, message });

/**
 * The only writer of `ledgerEntries`.
 *
 * `reversesEntryId` is not just carried through: it exempts the row from the
 * sign check, because inverting the sign is precisely what a reversal is.
 */
export async function postEntry(ctx: MutationCtx, input: PostInput): Promise<Id<"ledgerEntries">> {
  const amountCents = assertCents(input.amountCents);

  if (amountCents === 0) {
    throw bad(
      "ZERO_ENTRY",
      "A zero-amount ledger entry records nothing. If you meant to cancel an entry, reverse it.",
    );
  }

  const description = input.description.trim();
  if (!description) {
    throw bad(
      "INVALID",
      "A ledger line needs a description — one nobody can identify is not evidence.",
    );
  }

  const venture = await ctx.db.get(input.ventureId);
  if (!venture) throw bad("NO_SUCH_VENTURE", "No such venture.");

  if (input.clientId) {
    const client = await ctx.db.get(input.clientId);
    if (!client) throw bad("NO_SUCH_CLIENT", "No such client.");
    if (client.ventureId !== input.ventureId) {
      throw bad(
        "CLIENT_VENTURE_MISMATCH",
        `${client.name} does not belong to ${venture.name}. Money recorded against the wrong venture makes both P&Ls wrong.`,
      );
    }
    if (client.isDemo || client.isSeed) {
      throw bad(
        "NOT_A_REAL_CLIENT",
        `${client.name} is ${client.isSeed ? "seed" : "demo"} data. Money cannot be recorded against it.`,
      );
    }
  }

  if (!input.reversesEntryId) {
    const required = REQUIRED_SIGN[input.type];
    if (required !== null && required !== undefined) {
      const actual = amountCents > 0 ? 1 : -1;
      if (actual !== required) {
        throw bad(
          "WRONG_SIGN",
          `A ${input.type} must be ${required > 0 ? "positive" : "negative"}. ` +
            `Stored the other way it does not error — it quietly reports ${
              required > 0 ? "a loss as income" : "a refund as revenue"
            }.`,
        );
      }
    }
  }

  return ctx.db.insert("ledgerEntries", {
    ventureId: input.ventureId,
    clientId: input.clientId,
    invoiceId: input.invoiceId,
    type: input.type,
    amountCents,
    currency: input.currency,
    occurredAt: input.occurredAt,
    description,
    reversesEntryId: input.reversesEntryId,
    createdBy: input.createdBy,
    impersonationSessionId: input.impersonationSessionId,
  });
}

/**
 * Correct an entry by writing its opposite. Never by editing it.
 *
 * Refused twice over: a reversal cannot itself be reversed (record a fresh
 * entry — reversing a reversal is a re-statement pretending to be a
 * correction), and an entry cannot be reversed twice (which would subtract
 * the amount from the venture a second time and quietly invent a loss).
 */
export async function reverseEntry(
  ctx: MutationCtx,
  entryId: Id<"ledgerEntries">,
  reason: string,
  actor?: Id<"users">,
): Promise<{ reversalId: Id<"ledgerEntries">; amountCents: number; original: Doc<"ledgerEntries"> }> {
  const original = await ctx.db.get(entryId);
  if (!original) throw bad("NOT_FOUND", "No such ledger entry.");

  if (original.reversesEntryId) {
    throw bad(
      "ALREADY_A_REVERSAL",
      "That entry is itself a reversal. Record a fresh entry instead.",
    );
  }

  const siblings = await ctx.db
    .query("ledgerEntries")
    .withIndex("by_venture_occurred", (q) => q.eq("ventureId", original.ventureId))
    .collect();
  if (siblings.some((entry) => entry.reversesEntryId === entryId)) {
    throw bad("ALREADY_REVERSED", "That entry has already been reversed.");
  }

  const trimmed = reason.trim();
  const reversalId = await postEntry(ctx, {
    ventureId: original.ventureId,
    clientId: original.clientId,
    invoiceId: original.invoiceId,
    type: original.type as LedgerType,
    amountCents: -original.amountCents,
    currency: original.currency,
    /*
     * Dated NOW, not at the original's occurredAt. The correction happened
     * today; backdating it would rewrite a period that has already been
     * reported on, and the point of an append-only ledger is that a closed
     * month stays closed.
     */
    occurredAt: Date.now(),
    description: `Reversal: ${original.description} — ${trimmed || "no reason given"}`,
    reversesEntryId: entryId,
    createdBy: actor,
  });

  return { reversalId, amountCents: -original.amountCents, original };
}

/**
 * WHAT THIS LEDGER DELIBERATELY CANNOT DO YET: RECEIVABLES.
 *
 * "What does this client owe me" is not answerable here, and the reason is
 * not that the query is hard. A debt exists because the customer was sent a
 * numbered document with a legal name and a registration number on it. There
 * is no registered entity behind this platform yet, so there is nothing to
 * issue, so there is nothing anyone owes.
 *
 * The ledger itself never needed that entity — everything above records money
 * that actually moved, and needs no letterhead to be true. The boundary falls
 * exactly at the document, which is why `invoices` has no writer and
 * guards.test.ts holds it that way rather than leaving a half-built engine
 * that looks finished.
 *
 * So `aging`, `outstanding` and `overdue` are absent rather than returning
 * zero. A zero would be a claim that nothing is owed.
 */
