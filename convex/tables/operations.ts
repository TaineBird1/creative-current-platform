import { defineTable } from "convex/server";
import { v } from "convex/values";
import { currency } from "./tenants";

export const operationsTables = {
  services: defineTable({
    clientId: v.id("clients"),
    locationIds: v.optional(v.array(v.id("locations"))),
    key: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    durationMinutes: v.number(),
    bufferBeforeMinutes: v.number(),
    bufferAfterMinutes: v.number(),
    priceCents: v.optional(v.number()),
    currency,
    quoteRequired: v.boolean(),
    active: v.boolean(),
    sortOrder: v.number(),
  }).index("by_client", ["clientId", "active", "sortOrder"]),

  /** End customers of a tenant. They never get platform accounts. */
  customers: defineTable({
    clientId: v.id("clients"),
    name: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    addresses: v.array(v.object({ label: v.string(), line: v.string(), suburb: v.string(), city: v.string() })),
    /** The lock-in memory: preferences, spec notes, access instructions. */
    notes: v.optional(v.string()),
    tags: v.array(v.string()),
    noShowCount: v.number(),
    /** Nightly Client-360. Currency is denormalised from the client so the
     *  amount is never readable without it. */
    lifetimeValueCents: v.number(),
    currency,
    visitCount: v.number(),
    lastVisitAt: v.optional(v.number()),
    dueForServiceAt: v.optional(v.number()),
    /** Merge-duplicates leaves a tombstone rather than deleting history. */
    mergedIntoId: v.optional(v.id("customers")),
    isDemo: v.boolean(),
    isSeed: v.boolean(),
  })
    .index("by_client_phone", ["clientId", "phone"])
    .index("by_client_email", ["clientId", "email"])
    .index("by_client_due", ["clientId", "dueForServiceAt"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["clientId"] }),

  /**
   * Append-only consent log. POPIA lawful basis lives here, per channel.
   * The send pipeline reads the latest row per (customer, channel); a STOP
   * writes a `withdrawn` row rather than mutating anything.
   */
  consents: defineTable({
    clientId: v.id("clients"),
    customerId: v.id("customers"),
    channel: v.union(v.literal("whatsapp"), v.literal("email"), v.literal("sms")),
    state: v.union(v.literal("granted"), v.literal("withdrawn")),
    lawfulBasis: v.union(v.literal("consent"), v.literal("contract"), v.literal("legitimate_interest")),
    source: v.string(),
    at: v.number(),
  }).index("by_customer_channel", ["customerId", "channel", "at"]),

  /**
   * Overlap-safe by construction: the mutation reads the target window
   * through `by_location_start` and writes into it in the same transaction.
   * Convex mutations are serializable, so a concurrent double-book conflicts
   * and retries rather than both committing. Concurrency-tested.
   */
  bookings: defineTable({
    clientId: v.id("clients"),
    locationId: v.id("locations"),
    customerId: v.id("customers"),
    serviceId: v.id("services"),
    staffUserId: v.optional(v.id("users")),
    startsAt: v.number(),
    endsAt: v.number(),
    /**
     * Bumped by ANY change to startsAt. It exists so a rescheduled booking's
     * confirmation is a NEW message rather than a suppressed duplicate:
     * message keys carry it alongside startsAt, which is what makes a
     * 09:00 -> 10:00 -> 09:00 sequence three distinct messages instead of two.
     *
     * `book` initialises it at 1. Nothing else writes startsAt today, and
     * guards.test.ts fails if anything starts to — see "reschedule must bump
     * the message revision" there before adding drag-reschedule.
     */
    messageRevision: v.number(),
    status: v.union(
      v.literal("pending"), v.literal("confirmed"), v.literal("in_progress"),
      v.literal("completed"), v.literal("cancelled"), v.literal("no_show"),
    ),
    source: v.union(v.literal("site"), v.literal("back_office"), v.literal("phone"), v.literal("import")),
    notes: v.optional(v.string()),
    recurrenceId: v.optional(v.string()),
    isDemo: v.boolean(),
  })
    .index("by_location_start", ["locationId", "startsAt"])
    .index("by_client_start", ["clientId", "startsAt"])
    .index("by_staff_start", ["staffUserId", "startsAt"])
    .index("by_customer", ["customerId", "startsAt"])
    /**
     * ACROSS EVERY CLIENT, by time. The reminder sweep is a platform cron: it
     * asks "what starts in about 24 hours" without knowing whose booking it
     * is, so a client-scoped index cannot answer it without reading every
     * client in turn. Nothing tenant-scoped may use this one — a query that
     * does not restate its own clientId is exactly the shape tenancy exists to
     * prevent.
     */
    .index("by_start", ["startsAt"]),

  /** Block-outs and leave occupy the same calendar space as bookings. */
  blockouts: defineTable({
    clientId: v.id("clients"),
    locationId: v.id("locations"),
    staffUserId: v.optional(v.id("users")),
    startsAt: v.number(),
    endsAt: v.number(),
    reason: v.string(),
  }).index("by_location_start", ["locationId", "startsAt"]),

  /**
   * A submission from the public site's quote flow. Distinct from `quotes`:
   * this is what the CUSTOMER sent, before anyone has priced anything. M1
   * ships this table and nothing downstream of it.
   */
  quoteRequests: defineTable({
    clientId: v.id("clients"),
    siteId: v.id("sites"),
    locationId: v.optional(v.id("locations")),
    customerId: v.optional(v.id("customers")),
    serviceKey: v.optional(v.string()),
    /** Zero friction: name + phone are the only required fields. */
    name: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    /** Answers to the section's configured fields, keyed by field key. */
    answers: v.record(v.string(), v.string()),
    photoStorageIds: v.array(v.id("_storage")),
    status: v.union(
      v.literal("new"), v.literal("contacted"),
      v.literal("quoted"), v.literal("won"), v.literal("lost"),
    ),
    /** POPIA: what they agreed to, in the words shown on the page. */
    consentText: v.string(),
    lawfulBasis: v.union(v.literal("consent"), v.literal("contract"), v.literal("legitimate_interest")),
    submittedAt: v.number(),
    userAgent: v.optional(v.string()),
    /** True when the submission came from a demo site: never a real lead. */
    isDemo: v.boolean(),
  })
    .index("by_client_status", ["clientId", "status", "submittedAt"])
    .index("by_client_submitted", ["clientId", "submittedAt"])
    .index("by_site", ["siteId", "submittedAt"]),

  quotes: defineTable({
    clientId: v.id("clients"),
    customerId: v.id("customers"),
    number: v.string(),
    lineItems: v.array(v.object({
      description: v.string(),
      quantity: v.number(),
      unitPriceCents: v.number(),
      taxable: v.boolean(),
    })),
    subtotalCents: v.number(),
    totalCents: v.number(),
    currency,
    status: v.union(
      v.literal("draft"), v.literal("sent"), v.literal("accepted"),
      v.literal("declined"), v.literal("expired"),
    ),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    /** Customer accept-link. Hashed; the plaintext lives only in the link. */
    acceptTokenHash: v.string(),
    /**
     * How many times the accept link has been minted again after the first
     * send. It exists to make the idempotency key differ: `quote.sent` is
     * keyed on the quote id, so without an ordinal the outbox would refuse a
     * deliberate re-send as a duplicate — and a customer who says "I never got
     * it" would be told, silently, that they had.
     */
    acceptLinkResends: v.optional(v.number()),
    pdfStorageId: v.optional(v.id("_storage")),
    isDemo: v.boolean(),
  })
    .index("by_client_status", ["clientId", "status"])
    .index("by_acceptTokenHash", ["acceptTokenHash"])
    .index("by_customer", ["customerId"]),

  /**
   * WHAT THE CUSTOMER ACTUALLY AGREED TO.
   *
   * Accepting a quote is the closest thing in this system to signing
   * something, and until this table existed the only record of it was the
   * quote row itself — which staff can edit afterwards. "What did they agree
   * to" would then have been answerable only as "whatever it says now", which
   * is not an answer at all when the disagreement is about a price.
   *
   * So the terms are SNAPSHOTTED here at accept time, exactly as
   * `invoices.issuerLegalName` and `billToName` are snapshotted onto an
   * invoice: the document is history, and history does not move.
   *
   * APPEND-ONLY, and held that way by guards.test.ts alongside ledgerEntries,
   * auditLog and consents. A record of what somebody agreed to is worth
   * nothing if it can be revised.
   *
   * ONE ROW PER QUOTE, enforced by the accept path reading `by_quote` before
   * inserting. A customer on bad signal double-tapping Accept must produce one
   * acceptance, not two.
   */
  quoteAcceptances: defineTable({
    clientId: v.id("clients"),
    quoteId: v.id("quotes"),
    customerId: v.id("customers"),
    /** The number as printed on what they read. */
    number: v.string(),
    /** The lines as they stood. Not a reference — a copy. */
    lineItems: v.array(v.object({
      description: v.string(),
      quantity: v.number(),
      unitPriceCents: v.number(),
      taxable: v.boolean(),
    })),
    subtotalCents: v.number(),
    totalCents: v.number(),
    currency,
    /**
     * The terms: when the offer they accepted would have lapsed. Kept because
     * "was it still valid when they said yes" is the first question anybody
     * asks about a disputed acceptance, and it is unanswerable later if the
     * quote's own expiry is edited or the quote is re-sent.
     */
    validUntil: v.number(),
    acceptedAt: v.number(),
    /**
     * The job this created, when the branch was unambiguous. Absent means
     * staff still have to create it — see public/quote.accept, which refuses
     * to guess a branch.
     */
    jobId: v.optional(v.id("jobs")),
    isDemo: v.boolean(),
  })
    .index("by_quote", ["quoteId"])
    .index("by_client", ["clientId", "acceptedAt"]),

  jobs: defineTable({
    clientId: v.id("clients"),
    quoteId: v.optional(v.id("quotes")),
    customerId: v.id("customers"),
    locationId: v.id("locations"),
    status: v.union(
      v.literal("quoted"), v.literal("accepted"), v.literal("scheduled"),
      v.literal("in_progress"), v.literal("complete"), v.literal("cancelled"),
    ),
    scheduledFor: v.optional(v.number()),
    crewUserIds: v.array(v.id("users")),
    photoStorageIds: v.array(v.id("_storage")),
    materials: v.array(v.object({ name: v.string(), quantity: v.number(), unitCostCents: v.number() })),
    currency,
  })
    .index("by_client_status", ["clientId", "status"])
    .index("by_customer", ["customerId"]),
};
