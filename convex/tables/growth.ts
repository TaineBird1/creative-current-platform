import { defineTable } from "convex/server";
import { v } from "convex/values";
import { currency } from "./tenants";

/**
 * PLATFORM-SCOPED DATA (M4). None of this is tenant data — it carries a
 * ventureId, never a clientId, and is reachable only through requirePlatform.
 * A tenant guard applied here would be a category error; the guard test
 * asserts these modules use the platform wrapper.
 */
export const growthTables = {
  geoAreas: defineTable({
    parentId: v.optional(v.id("geoAreas")),
    level: v.union(v.literal("country"), v.literal("region"), v.literal("city"), v.literal("area")),
    name: v.string(),
    countryCode: v.string(),
    leadCount: v.number(),
    contactedCount: v.number(),
    wonCount: v.number(),
  }).index("by_parent", ["parentId", "name"]),

  leads: defineTable({
    ventureId: v.id("ventures"),
    geoAreaId: v.optional(v.id("geoAreas")),
    placeId: v.string(),
    businessName: v.string(),
    niche: v.string(),
    phone: v.optional(v.string()),
    website: v.optional(v.string()),
    rating: v.optional(v.number()),
    reviewCount: v.optional(v.number()),
    /** Free website audit score + the two specific faults the call note uses. */
    auditScore: v.optional(v.number()),
    auditFaults: v.array(v.string()),
    callNote: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    ownerNameConfidence: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
    ownerNameSource: v.optional(v.string()),
    status: v.union(
      v.literal("new"), v.literal("queued"), v.literal("working"),
      v.literal("demo_sent"), v.literal("converted"), v.literal("discarded"),
    ),
    bestCallHour: v.optional(v.number()),
    convertedClientId: v.optional(v.id("clients")),
  })
    .index("by_placeId", ["placeId"])
    .index("by_status", ["status"])
    .index("by_geo_status", ["geoAreaId", "status"]),

  /** Retroactive + learning. A match here removes a lead from every future pull. */
  suppressions: defineTable({
    kind: v.union(v.literal("placeId"), v.literal("domain"), v.literal("phone"), v.literal("nameFragment")),
    value: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  }).index("by_kind_value", ["kind", "value"]),

  companies: defineTable({
    ventureId: v.id("ventures"),
    leadId: v.optional(v.id("leads")),
    name: v.string(),
    domain: v.optional(v.string()),
  }).index("by_lead", ["leadId"]),

  contacts: defineTable({
    companyId: v.id("companies"),
    name: v.string(),
    role: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
  }).index("by_company", ["companyId"]),

  /** Cadences as data. Sequences SCHEDULE and DRAFT. They never send. */
  sequences: defineTable({
    ventureId: v.id("ventures"),
    name: v.string(),
    active: v.boolean(),
    steps: v.array(v.object({
      offsetDays: v.number(),
      action: v.union(v.literal("call"), v.literal("whatsapp_draft"), v.literal("email_draft"), v.literal("task")),
      templateKey: v.optional(v.string()),
    })),
  }).index("by_active", ["active"]),

  sequenceEnrolments: defineTable({
    sequenceId: v.id("sequences"),
    leadId: v.id("leads"),
    stepIndex: v.number(),
    dueAt: v.number(),
    status: v.union(v.literal("active"), v.literal("exited"), v.literal("completed")),
    lastDisposition: v.optional(v.string()),
  })
    .index("by_status_dueAt", ["status", "dueAt"])
    .index("by_lead", ["leadId"]),

  dispositions: defineTable({
    leadId: v.id("leads"),
    userId: v.id("users"),
    outcome: v.union(
      v.literal("no_answer"), v.literal("voicemail"), v.literal("callback"),
      v.literal("meeting_set"), v.literal("not_interested"), v.literal("wrong_number"),
    ),
    note: v.optional(v.string()),
    calledAt: v.number(),
    callbackAt: v.optional(v.number()),
  }).index("by_lead", ["leadId", "calledAt"]),

  deals: defineTable({
    ventureId: v.id("ventures"),
    leadId: v.id("leads"),
    stage: v.union(
      v.literal("demo_booked"), v.literal("demo_completed"), v.literal("pricing_presented"),
      v.literal("verbal_commit"), v.literal("won"), v.literal("lost"),
    ),
    valueCents: v.number(),
    currency,
    probability: v.number(),
    /** Mandatory on lost. Enforced in the mutation, not just the form. */
    lossReason: v.optional(v.string()),
    closedAt: v.optional(v.number()),
  }).index("by_stage", ["stage"]),

  /** Records, not users. Accrual on PAID only. */
  agents: defineTable({
    ventureId: v.id("ventures"),
    name: v.string(),
    phone: v.string(),
    planId: v.id("commissionPlans"),
    active: v.boolean(),
  }).index("by_active", ["active"]),

  commissionPlans: defineTable({
    name: v.string(),
    basisPoints: v.number(),
    capCents: v.optional(v.number()),
    currency,
    months: v.optional(v.number()),
  }),

  commissions: defineTable({
    agentId: v.id("agents"),
    invoiceId: v.id("invoices"),
    amountCents: v.number(),
    currency,
    accruedAt: v.number(),
    paidAt: v.optional(v.number()),
  }).index("by_agent_paid", ["agentId", "paidAt"]),

  referrals: defineTable({
    referrerClientId: v.id("clients"),
    referredClientId: v.id("clients"),
    creditCents: v.number(),
    currency,
    creditedInvoiceId: v.optional(v.id("invoices")),
    creditedAt: v.optional(v.number()),
  }).index("by_referrer", ["referrerClientId"]),
};
