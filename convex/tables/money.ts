import { defineTable } from "convex/server";
import { v } from "convex/values";
import { currency } from "./tenants";

/**
 * MONEY RULE: integer cents as v.number(), always beside its currency.
 *
 * Not bigint. Integer cents are exact in float64 to 2^53 (~R90 trillion), so
 * bigint would guard a bug class that is already gone -- while breaking
 * JSON.stringify in every webhook, PDF and CSV path. The integer-ness is
 * enforced instead at the one choke point that matters: assertCents() in
 * lib/money.ts, called by every ledger and invoice write.
 *
 * An amount is never stored without its currency in the same table. Totals
 * are per-currency only; there is no code that sums across them.
 */

export const moneyTables = {
  /**
   * Sequential invoice numbers, per (venture, series). A single document
   * patched inside the issuing mutation. Convex serializability means two
   * concurrent issues cannot take the same number — and cannot skip one.
   */
  invoiceCounters: defineTable({
    ventureId: v.id("ventures"),
    series: v.string(),
    next: v.number(),
  }).index("by_venture_series", ["ventureId", "series"]),

  invoices: defineTable({
    ventureId: v.id("ventures"),
    clientId: v.id("clients"),
    number: v.string(),
    numberSeq: v.number(),
    currency,
    lineItems: v.array(v.object({
      description: v.string(),
      quantity: v.number(),
      unitPriceCents: v.number(),
      taxable: v.boolean(),
      /** Referral credits ride in as a negative line, not a separate concept. */
      kind: v.union(v.literal("charge"), v.literal("credit")),
    })),
    subtotalCents: v.number(),
    taxCents: v.number(),
    totalCents: v.number(),
    /** Off until VAT registration. No VAT line renders while false. */
    taxFlag: v.boolean(),
    taxRateBasisPoints: v.optional(v.number()),
    /** Snapshotted at issue: the legal entity as it was on the document. */
    issuerLegalName: v.string(),
    issuerRegistrationNumber: v.optional(v.string()),
    issuerVatNumber: v.optional(v.string()),
    status: v.union(
      v.literal("draft"), v.literal("issued"), v.literal("paid"),
      v.literal("overdue"), v.literal("void"), v.literal("written_off"),
    ),
    issuedAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    provider: v.optional(v.union(v.literal("paystack"), v.literal("paddle"), v.literal("eft"), v.literal("manual"))),
    providerRef: v.optional(v.string()),
    pdfStorageId: v.optional(v.id("_storage")),
    /** Set once at creation; blocks any real charge against demo data. */
    isDemo: v.boolean(),
  })
    .index("by_client_status", ["clientId", "status"])
    .index("by_venture_seq", ["ventureId", "numberSeq"])
    .index("by_status_dueAt", ["status", "dueAt"])
    .index("by_providerRef", ["providerRef"]),

  /**
   * IMMUTABLE LEDGER. Insert-only: no patch, no delete, no exceptions.
   * Balances are derived, never stored on the client. Corrections are new
   * reversing entries. Integrity tests assert sum(entries) == derived balance.
   */
  ledgerEntries: defineTable({
    ventureId: v.id("ventures"),
    clientId: v.optional(v.id("clients")),
    invoiceId: v.optional(v.id("invoices")),
    type: v.union(
      v.literal("invoice_issued"), v.literal("payment_received"),
      v.literal("refund"), v.literal("credit_note"), v.literal("write_off"),
      v.literal("commission_accrued"), v.literal("commission_paid"),
      v.literal("expense"), v.literal("property_income"), v.literal("adjustment"),
    ),
    /** Signed. Positive = owed to us / income. Never summed across currencies. */
    amountCents: v.number(),
    currency,
    occurredAt: v.number(),
    description: v.string(),
    /** Points at the entry this one reverses, when it is a correction. */
    reversesEntryId: v.optional(v.id("ledgerEntries")),
    createdBy: v.optional(v.id("users")),
    impersonationSessionId: v.optional(v.id("impersonationSessions")),
  })
    .index("by_client_occurred", ["clientId", "occurredAt"])
    .index("by_venture_occurred", ["ventureId", "occurredAt"])
    .index("by_invoice", ["invoiceId"]),

  payments: defineTable({
    ventureId: v.id("ventures"),
    clientId: v.id("clients"),
    invoiceId: v.optional(v.id("invoices")),
    amountCents: v.number(),
    currency,
    provider: v.union(v.literal("paystack"), v.literal("paddle"), v.literal("eft"), v.literal("manual"), v.literal("stripe"), v.literal("gocardless")),
    providerRef: v.string(),
    status: v.union(v.literal("pending"), v.literal("succeeded"), v.literal("failed"), v.literal("refunded")),
    receivedAt: v.number(),
    /** Webhook idempotency. Card data never lands here or anywhere else. */
    webhookEventId: v.optional(v.string()),
  })
    .index("by_invoice", ["invoiceId"])
    .index("by_providerRef", ["provider", "providerRef"])
    .index("by_webhookEventId", ["webhookEventId"]),

  subscriptions: defineTable({
    ventureId: v.id("ventures"),
    clientId: v.id("clients"),
    plan: v.string(),
    amountCents: v.number(),
    currency,
    provider: v.union(v.literal("paystack"), v.literal("paddle")),
    providerRef: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("past_due"), v.literal("cancelled")),
    nextBillingAt: v.optional(v.number()),
    /** Suspension is explicit-only. Never automatic on a failed charge. */
    suspendedAt: v.optional(v.number()),
    /**
     * The PROVIDER's timestamp on the event that last set `status`. Webhooks
     * arrive out of order, and this is what stops an older one rolling the
     * status back to a state the customer has already moved on from. Never
     * set from arrival time: a retry is minutes or hours after the fact.
     */
    lastEventAt: v.optional(v.number()),
  })
    .index("by_client", ["clientId"])
    .index("by_status_nextBilling", ["status", "nextBillingAt"]),

  /** Part 5.4 — attributable to a venture, optionally a client or property. */
  expenses: defineTable({
    ventureId: v.id("ventures"),
    clientId: v.optional(v.id("clients")),
    propertyUnitId: v.optional(v.id("propertyUnits")),
    description: v.string(),
    category: v.string(),
    amountCents: v.number(),
    currency,
    incurredAt: v.number(),
    vendor: v.optional(v.string()),
    receiptStorageId: v.optional(v.id("_storage")),
    recurring: v.boolean(),
  })
    .index("by_venture_incurred", ["ventureId", "incurredAt"])
    .index("by_client", ["clientId", "incurredAt"]),
};
