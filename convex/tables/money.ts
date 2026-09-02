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

  /**
   * WHO IS ISSUING. Required before a venture can invoice anything.
   *
   * A South African SOLE PROPRIETOR invoices in their own name and has no
   * registration number — there is nothing to register and nothing to wait
   * for. `registrationNumber` is therefore optional, and its absence is the
   * normal case rather than a gap: it appears when a Pty Ltd exists, and not
   * before.
   *
   * `vatNumber` is likewise absent until VAT registration, which is
   * compulsory only above R1m turnover. While it is absent no invoice renders
   * a VAT line, because charging VAT without being registered for it is a
   * different and much worse problem than not charging it.
   *
   * Per VENTURE, not per platform. One person can trade as a sole prop for
   * consulting and form a company for the sites business, and on the day that
   * happens only one venture's issuer changes.
   */
  issuers: defineTable({
    ventureId: v.id("ventures"),
    /** The legal person or company. For a sole prop, their own full name. */
    legalName: v.string(),
    /** The name on the letterhead, when it differs. */
    tradingName: v.optional(v.string()),
    /** Absent for a sole prop. Present once a Pty Ltd is registered. */
    registrationNumber: v.optional(v.string()),
    /** Absent until VAT registration. No VAT is charged while it is absent. */
    vatNumber: v.optional(v.string()),
    addressLine: v.string(),
    suburb: v.optional(v.string()),
    city: v.string(),
    postalCode: v.optional(v.string()),
    countryCode: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    /** Their OWN account, printed so a client can pay by EFT. */
    bankName: v.optional(v.string()),
    bankAccountName: v.optional(v.string()),
    bankAccountNumber: v.optional(v.string()),
    bankBranchCode: v.optional(v.string()),
    updatedAt: v.number(),
    /**
     * A HUMAN LOOKED AT THIS AND SAID IT WAS RIGHT.
     *
     * Null until confirmed, and every edit clears it again. `invoices.issue`
     * refuses an unconfirmed issuer, because the failure being prevented is
     * not an empty field — an empty field refuses on its own — it is a
     * PLAUSIBLE one. A legal name invented by a seed script, a test fixture
     * or an assistant filling in a form looks exactly like a real one and
     * prints at the top of a document a client keeps.
     *
     * Empty refuses. Plausible prints. So plausible has to refuse too, and
     * the only thing that can tell them apart is a person.
     */
    confirmedAt: v.optional(v.number()),
    confirmedBy: v.optional(v.id("users")),
  }).index("by_venture", ["ventureId"]),

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
    /**
     * LIFECYCLE ONLY. Whether it is PAID is not in here, on purpose.
     *
     * This union used to carry "paid" and "overdue", and `recordPayment`
     * patched the row to "paid" once the money covered it. That is a hand-set
     * flag for a fact the ledger already knows, and the two can disagree —
     * a refund posted afterwards leaves an invoice still stamped paid, which
     * throws nothing and reads as settled forever.
     *
     * Settlement and overdue are DERIVED from the ledger and from today. What
     * remains here is only what a person decides: it went out, it was
     * cancelled, or it was given up on.
     */
    status: v.union(v.literal("issued"), v.literal("void"), v.literal("written_off")),
    /**
     * SNAPSHOTTED, like the issuer. The document says "7 days" because that
     * is what was agreed on the day; changing the default next year must not
     * silently re-term an invoice a client is already holding.
     *
     * There is deliberately NO paymentReference column. The reference IS the
     * invoice number, and a second field could be set to something else —
     * which is not an error anywhere, just a deposit that reconciles to
     * nothing. See `paymentReference` in invoices.ts.
     */
    paymentTermsDays: v.number(),
    issuedAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
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

  /**
   * WHAT A MONTHLY FEE IS, ONCE.
   *
   * `subscriptions.plan` was a free string and `clients.packagePreset` another
   * one, which is two opinions about what a client pays and no source for
   * either. A plan is the template; the subscription SNAPSHOTS its amount at
   * the moment it starts, the same way an invoice snapshots the issuer — a
   * price rise must not silently rewrite what an existing client agreed to.
   *
   * `providerPlanCode` mirrors a plan created in Paystack's own dashboard.
   * Paystack owns the billing schedule, so the code here is a pointer to
   * theirs rather than a second definition of it: an interval stored here and
   * a different one there would bill on a cadence nobody chose.
   */
  plans: defineTable({
    ventureId: v.id("ventures"),
    /** Stable, ours, and never shown to a client. */
    key: v.string(),
    name: v.string(),
    amountCents: v.number(),
    currency,
    interval: v.union(v.literal("monthly"), v.literal("annually")),
    provider: v.union(v.literal("paystack"), v.literal("paddle")),
    /** The plan code from the provider's dashboard. Absent = cannot be sold. */
    providerPlanCode: v.optional(v.string()),
    active: v.boolean(),
  })
    .index("by_key", ["key"])
    .index("by_venture_active", ["ventureId", "active"]),

  subscriptions: defineTable({
    ventureId: v.id("ventures"),
    clientId: v.id("clients"),
    planId: v.optional(v.id("plans")),
    plan: v.string(),
    amountCents: v.number(),
    currency,
    provider: v.union(v.literal("paystack"), v.literal("paddle")),
    /**
     * OUR reference, handed to the provider when the checkout was opened and
     * echoed back on every transaction event for it.
     *
     * It exists because `providerRef` cannot do this job at the start: it
     * holds the PROVIDER's subscription code, which does not exist until the
     * customer has paid — so the very first `charge.success` has nothing to
     * match against and parks as unattributed, forever. A reference we
     * generate is known before the customer opens the page.
     */
    startReference: v.optional(v.string()),
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
    .index("by_status_nextBilling", ["status", "nextBillingAt"])
    /* The two routes a webhook has to find its subscription by. */
    .index("by_startReference", ["startReference"])
    .index("by_providerRef", ["providerRef"]),

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
