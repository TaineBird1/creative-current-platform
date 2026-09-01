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
    /**
     * OPTIONAL, because not every lead comes from Google.
     *
     * It was required, which quietly assumed Places was the only source. The
     * first real import — 59 KZN solar installers off trade directories — has
     * no Place IDs at all, and the tempting fix was to mint synthetic ones.
     * That would put a fabricated key in the column suppression matches on,
     * where it could later collide with a real Place ID and silently suppress
     * the wrong business.
     *
     * Absent is honest. `provenance` is the field that always answers where a
     * row came from; this one only says whether Google was involved.
     */
    placeId: v.optional(v.string()),
    businessName: v.string(),
    niche: v.string(),
    /**
     * E.164 (+27XXXXXXXXX), and it is a KEY, not a display string.
     * Suppression matches on it, `tel:` dials it. Written only by
     * lib/phone.ts — see the note there about the two normalisers that
     * disagreed.
     */
    phone: v.optional(v.string()),
    /**
     * What the source actually said: "0833176385 / 0622155142". Kept because
     * it is what a person recognises, and because it holds the second number
     * that normalising to a single key necessarily discards.
     */
    phoneDisplay: v.optional(v.string()),
    /**
     * Suburb or town, as the directory listed it. A public fact about a
     * business rather than Google Maps Content, so it does not expire.
     *
     * It exists as its own field because a DEMO needs it — the site says
     * "solar installation in Hillcrest" and that has to come from somewhere.
     * It was previously folded into `provenance.detail` and nowhere else,
     * which put it in the one field that may never be edited.
     */
    area: v.optional(v.string()),
    website: v.optional(v.string()),
    /*
     * NO rating OR reviewCount HERE, and the omission is deliberate.
     *
     * They lived on this row with no expiry, which is a permanent copy of
     * content Google licenses to us for 30 days. They live in `placesCache`
     * now, where the clock is enforced on read — join through `placeId`,
     * which is the one field the terms exempt and the reason it is stored
     * here at all.
     */

    /** Free website audit score + the two specific faults the call note uses. */
    auditScore: v.optional(v.number()),
    auditFaults: v.array(v.string()),
    callNote: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    ownerNameConfidence: v.optional(
      v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    ),
    ownerNameSource: v.optional(v.string()),

    /**
     * WHERE THIS ROW CAME FROM. REQUIRED, AND NEVER BACKFILLED.
     *
     * "Where did you get my number" is a question a stranger is entitled to
     * ask and we are obliged to answer, and it has to be answerable from the
     * ROW rather than from somebody's memory of which spreadsheet a batch
     * came out of.
     *
     * Required rather than optional, because optional means the rows that
     * most need it — a hurried import, a list somebody pasted in — are
     * exactly the ones that will not have it. A lead that cannot say where it
     * came from cannot be created.
     *
     * NOT BACKFILLABLE, enforced by guards.test.ts: nothing may patch this
     * field. A provenance written later is a guess about the past dressed as
     * a record of it, and the only reason to write one is that the true
     * answer was not kept. That is precisely when a guess is worst.
     */
    provenance: v.object({
      source: v.union(
        v.literal("places"),
        v.literal("sa_venues"),
        /** A list compiled off trade directories, e.g. SolarZA, ENF, Procompare. */
        v.literal("campaign_list"),
        v.literal("referral"),
        v.literal("inbound"),
      ),
      /** When WE obtained it. Not when the business came into existence. */
      capturedAt: v.number(),
      /**
       * The POPIA basis being relied on to hold and use this, as claimed by
       * the operator at capture. The code stores it and makes it auditable;
       * it does not and cannot validate that the claim is correct.
       *
       * `consent` is for inbound — they came to us. `legitimate_interest` is
       * the basis for B2B prospecting, and note that POPIA s69 treats
       * electronic DIRECT MARKETING more strictly than a phone call to a
       * listed business number: a basis recorded here is not a finding that
       * any particular channel is permitted.
       */
      lawfulBasis: v.union(v.literal("consent"), v.literal("legitimate_interest")),
      /**
       * The specific answer to "where". The search that returned it, the name
       * of the person who referred them, the form they filled in. A source
       * alone answers "from Google Places" and the follow-up question is
       * always "yes, but how did I end up on your list".
       */
      detail: v.optional(v.string()),
    }),

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
  })
    .index("by_stage", ["stage"])
    // The pipeline is idempotent on "one OPEN deal per lead", so opening one
    // has to be able to ask that question without scanning every deal.
    .index("by_lead", ["leadId"]),

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
