import { defineTable } from "convex/server";
import { v } from "convex/values";

export const currency = v.union(
  v.literal("ZAR"), v.literal("USD"), v.literal("EUR"),
  v.literal("GBP"), v.literal("NAD"), v.literal("BWP"),
);

export const ventureType = v.union(
  v.literal("platform"), v.literal("consulting"),
  v.literal("property"), v.literal("other"),
);

export const tenantTables = {
  /**
   * Part 5.1 — ventures as a first-class dimension. Venture #1 is the platform
   * itself. Every client, invoice, expense, ledger entry and task carries a
   * ventureId, so per-venture P&L is a filter, never a migration.
   */
  ventures: defineTable({
    name: v.string(),
    type: ventureType,
    currency,
    active: v.boolean(),
    sortOrder: v.number(),
  }).index("by_active", ["active", "sortOrder"]),

  /**
   * THE TENANT. `kind:"platform"` gets a site, a back office and a
   * subscription. `kind:"external"` (Part 5.2) is a consulting/side client:
   * invoices + ledger + tasks + documents, no portal, no feature manager.
   */
  clients: defineTable({
    ventureId: v.id("ventures"),
    kind: v.union(v.literal("platform"), v.literal("external")),

    /**
     * White-label: an agency IS a client (they pay you); their clients are
     * clients pointing back at them. A membership at the agency grants
     * structure-tier rights over its downstream clients and nothing else.
     * This is the ONLY place tenancy is not a flat equality check — it has
     * its own test.
     *
     * DEPTH IS EXACTLY 1, enforced in the write path (lib/reseller.ts), not by
     * convention: a client that HAS a resellerId can never BE one. Without
     * that check the membership walk becomes an unbounded graph traversal and
     * a cycle would hang the resolver.
     */
    resellerId: v.optional(v.id("clients")),

    name: v.string(),
    legalName: v.optional(v.string()),
    /** Present only for kind:"platform". Drives app.<domain>/c/<slug>. */
    slug: v.optional(v.string()),

    status: v.union(
      v.literal("prospect"), v.literal("pending"), v.literal("onboarding"),
      v.literal("live"), v.literal("suspended"), v.literal("churned"),
    ),

    brandColour: v.optional(v.string()),
    timezone: v.string(),
    currency,

    primaryContactName: v.optional(v.string()),
    primaryContactPhone: v.optional(v.string()),
    primaryContactEmail: v.optional(v.string()),

    /** Feature Manager: absent modules are hidden, not locked. */
    featureFlags: v.record(v.string(), v.boolean()),
    packagePreset: v.optional(v.string()),

    healthScore: v.optional(v.number()),
    healthComputedAt: v.optional(v.number()),

    /** Dispatch + revenue blocks key off these. Never both false by accident. */
    isDemo: v.boolean(),
    isSeed: v.boolean(),

    goLiveAt: v.optional(v.number()),
    churnedAt: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_venture", ["ventureId", "status"])
    .index("by_reseller", ["resellerId"])
    .index("by_status", ["status"])
    .index("by_kind", ["kind", "status"]),

  /**
   * Old slug -> current client. A rebrand must not break installed PWAs,
   * bookmarks, or a QR till card already printed and stuck to a counter.
   * Resolution tries the live slug first, then falls back here and answers
   * with a canonical redirect. An alias is retired, never reused.
   */
  clientSlugAliases: defineTable({
    slug: v.string(),
    clientId: v.id("clients"),
    retiredAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_client", ["clientId"]),

  /** Branches. Managers are scoped to exactly one of these. */
  locations: defineTable({
    clientId: v.id("clients"),
    name: v.string(),
    addressLine: v.string(),
    suburb: v.string(),
    city: v.string(),
    region: v.string(),
    countryCode: v.string(),
    postalCode: v.optional(v.string()),
    lat: v.optional(v.number()),
    lng: v.optional(v.number()),
    placeId: v.optional(v.string()),
    phone: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    /** Per-site timezone stored regardless of the Africa/Johannesburg default. */
    timezone: v.string(),
    active: v.boolean(),
  })
    .index("by_client", ["clientId", "active"])
    .index("by_placeId", ["placeId"]),
};
