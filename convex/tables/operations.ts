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
    .index("by_customer", ["customerId", "startsAt"]),

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
    pdfStorageId: v.optional(v.id("_storage")),
    isDemo: v.boolean(),
  })
    .index("by_client_status", ["clientId", "status"])
    .index("by_acceptTokenHash", ["acceptTokenHash"])
    .index("by_customer", ["customerId"]),

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
