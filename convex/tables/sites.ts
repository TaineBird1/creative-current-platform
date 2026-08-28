import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * SiteConfig is stored as an OPAQUE object, not a generated Convex validator.
 *
 * Why: the section registry is open-ended by design. A validator generated
 * from the Zod union would need regenerating for every new section type, and
 * would reject configs written by a newer deploy during a rolling one.
 * Instead there is exactly ONE writer -- convex/siteConfigs.ts -- which parses
 * through Zod before every insert or patch, and the renderer parses again on
 * read. guards.test.ts fails CI if any other file writes the sites table.
 */
const siteConfigBlob = v.any();

export const siteTables = {
  /** A website is a row. Fixes ship to every client at once. */
  sites: defineTable({
    clientId: v.id("clients"),
    /** Duplicated from clients.slug for ?site= preview and demo lookups. */
    slug: v.string(),
    status: v.union(
      v.literal("draft"), v.literal("demo"),
      v.literal("live"), v.literal("archived"),
    ),
    /** Working copy -- what the editor writes. Zod-valid at write time. */
    config: siteConfigBlob,
    /** What apps/sites serves. Publishing copies config -> publishedConfig. */
    publishedConfig: v.optional(siteConfigBlob),
    /** Bumped on every accepted write. Cheap optimistic-concurrency check. */
    version: v.number(),
    /** SITE_CONFIG_VERSION the stored blob was written against, for migration. */
    configSchemaVersion: v.number(),
    publishedAt: v.optional(v.number()),
    publishedBy: v.optional(v.id("users")),
    /** Demos expire in 30 days; the slug stays stable so links don't rot. */
    demoExpiresAt: v.optional(v.number()),
    leadId: v.optional(v.id("leads")),
    isDemo: v.boolean(),
  })
    .index("by_slug", ["slug"])
    .index("by_client", ["clientId"])
    .index("by_status", ["status"])
    .index("by_demoExpiry", ["status", "demoExpiresAt"]),

  /** Host -> site. The first hop of tenant resolution on the public app. */
  domains: defineTable({
    siteId: v.id("sites"),
    clientId: v.id("clients"),
    hostname: v.string(),
    isPrimary: v.boolean(),
    verificationStatus: v.union(v.literal("pending"), v.literal("verified"), v.literal("failed")),
    sslStatus: v.union(v.literal("pending"), v.literal("issued"), v.literal("failed")),
    vercelDomainId: v.optional(v.string()),
    registrarExpiresAt: v.optional(v.number()),
    lastCheckedAt: v.optional(v.number()),
  })
    .index("by_hostname", ["hostname"])
    .index("by_client", ["clientId"])
    .index("by_site", ["siteId"]),

  /** SEO transfer: legacy 301s per site. */
  redirects: defineTable({
    siteId: v.id("sites"),
    from: v.string(),
    to: v.string(),
    statusCode: v.union(v.literal(301), v.literal(302), v.literal(308)),
  }).index("by_site_from", ["siteId", "from"]),

  /**
   * Demo engagement lands on the LEAD, not on a tenant. Sandboxed forms on a
   * demo write here and nowhere else — a demo can never create a real booking.
   */
  demoEngagements: defineTable({
    siteId: v.id("sites"),
    leadId: v.id("leads"),
    kind: v.union(v.literal("opened"), v.literal("booking_tested"), v.literal("quote_tested"), v.literal("called")),
    at: v.number(),
    meta: v.optional(v.record(v.string(), v.string())),
  })
    .index("by_lead", ["leadId", "at"])
    .index("by_site", ["siteId", "at"]),
};
