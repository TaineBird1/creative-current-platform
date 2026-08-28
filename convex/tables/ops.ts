import { defineTable } from "convex/server";
import { v } from "convex/values";
import { currency } from "./tenants";

export const opsTables = {
  /** Part 5.5 — one inbox. Venture-filterable, client-optional. */
  tasks: defineTable({
    ventureId: v.id("ventures"),
    clientId: v.optional(v.id("clients")),
    propertyUnitId: v.optional(v.id("propertyUnits")),
    title: v.string(),
    body: v.optional(v.string()),
    assigneeUserId: v.optional(v.id("users")),
    dueAt: v.optional(v.number()),
    status: v.union(v.literal("open"), v.literal("doing"), v.literal("done"), v.literal("cancelled")),
    /** Set when a trigger created it, so automation-made tasks are auditable. */
    triggerKey: v.optional(v.string()),
  })
    .index("by_venture_status", ["ventureId", "status", "dueAt"])
    .index("by_assignee", ["assigneeUserId", "status"])
    .index("by_client", ["clientId", "status"]),

  /** "Ask us to change it" — SLA-timed, threaded, tenant-scoped. */
  queries: defineTable({
    clientId: v.id("clients"),
    openedByUserId: v.id("users"),
    subject: v.string(),
    status: v.union(v.literal("open"), v.literal("answered"), v.literal("closed")),
    slaDueAt: v.number(),
    firstResponseAt: v.optional(v.number()),
  }).index("by_client_status", ["clientId", "status"]),

  queryMessages: defineTable({
    queryId: v.id("queries"),
    clientId: v.id("clients"),
    authorUserId: v.id("users"),
    body: v.string(),
    at: v.number(),
  }).index("by_query", ["queryId", "at"]),

  /** Onboarding checklist drives the tracker's phase columns. */
  onboardingItems: defineTable({
    clientId: v.id("clients"),
    key: v.string(),
    label: v.string(),
    phase: v.union(v.literal("intake"), v.literal("content"), v.literal("build"), v.literal("review"), v.literal("launch")),
    owner: v.union(v.literal("client"), v.literal("us")),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("blocked")),
    completedAt: v.optional(v.number()),
    staleSince: v.optional(v.number()),
  }).index("by_client_phase", ["clientId", "phase"]),

  /**
   * Append-only audit. Every impersonated write, every money mutation, every
   * permission change. Insert-only, same rule as ledgerEntries.
   */
  auditLog: defineTable({
    actorUserId: v.optional(v.id("users")),
    impersonationSessionId: v.optional(v.id("impersonationSessions")),
    ventureId: v.optional(v.id("ventures")),
    clientId: v.optional(v.id("clients")),
    action: v.string(),
    entityTable: v.string(),
    entityId: v.string(),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    at: v.number(),
  })
    .index("by_client_at", ["clientId", "at"])
    .index("by_actor_at", ["actorUserId", "at"])
    .index("by_entity", ["entityTable", "entityId"]),

  /** Phase A property: units + bookings-lite under a "property" venture. */
  propertyUnits: defineTable({
    ventureId: v.id("ventures"),
    clientId: v.id("clients"),
    name: v.string(),
    sleeps: v.number(),
    baseRateCents: v.number(),
    currency,
    timezone: v.string(),
    active: v.boolean(),
  }).index("by_client", ["clientId", "active"]),

  propertyBookings: defineTable({
    propertyUnitId: v.id("propertyUnits"),
    clientId: v.id("clients"),
    source: v.union(v.literal("airbnb"), v.literal("booking_com"), v.literal("direct"), v.literal("block"), v.literal("other")),
    guestName: v.optional(v.string()),
    guestPhone: v.optional(v.string()),
    checkIn: v.number(),
    checkOut: v.number(),
    nights: v.number(),
    grossCents: v.number(),
    currency,
    /** Set when the row came from an imported iCal feed; not hand-editable. */
    externalUid: v.optional(v.string()),
  })
    .index("by_unit_checkIn", ["propertyUnitId", "checkIn"])
    .index("by_externalUid", ["externalUid"]),

  icalFeeds: defineTable({
    propertyUnitId: v.id("propertyUnits"),
    direction: v.union(v.literal("import"), v.literal("export")),
    url: v.optional(v.string()),
    tokenHash: v.optional(v.string()),
    lastSyncedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  }).index("by_unit", ["propertyUnitId"]),

  /** Uptime / SSL / domain expiry sweeps. */
  siteChecks: defineTable({
    siteId: v.id("sites"),
    clientId: v.id("clients"),
    kind: v.union(v.literal("uptime"), v.literal("ssl"), v.literal("domain_expiry")),
    ok: v.boolean(),
    detail: v.optional(v.string()),
    checkedAt: v.number(),
  }).index("by_site_checked", ["siteId", "checkedAt"]),

  /** Trackable short links + QR. */
  shortLinks: defineTable({
    clientId: v.optional(v.id("clients")),
    code: v.string(),
    target: v.string(),
    hits: v.number(),
  }).index("by_code", ["code"]),
};
