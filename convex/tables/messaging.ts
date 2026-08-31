import { defineTable } from "convex/server";
import { v } from "convex/values";

export const messageChannel = v.union(
  v.literal("whatsapp"),
  v.literal("email"),
  v.literal("sms"), // column exists in v1; no driver ships until it does
);

export const messagingTables = {
  /**
   * ONE outbound pipeline for transactional client messages.
   * Outreach does NOT live here — sequences draft, Taine sends by hand.
   *
   * Idempotency: `idempotencyKey` is deterministic
   * (`${clientId}:${templateKey}:${subjectId}:${bucket}`) and checked through
   * by_idempotencyKey inside the enqueuing mutation. Serializable mutations
   * make that check a real uniqueness guarantee.
   */
  messages: defineTable({
    clientId: v.optional(v.id("clients")),
    ventureId: v.id("ventures"),
    customerId: v.optional(v.id("customers")),
    channel: messageChannel,
    to: v.string(),
    templateKey: v.string(),
    payload: v.record(v.string(), v.string()),
    idempotencyKey: v.string(),
    status: v.union(
      v.literal("scheduled"), v.literal("holding_quiet_hours"), v.literal("sending"),
      v.literal("sent"), v.literal("delivered"), v.literal("failed"),
      v.literal("suppressed_consent"), v.literal("suppressed_demo"),
    ),
    /**
     * The SITE's timezone, not the recipient's — named for what it actually
     * holds. Bookings collect a name and a phone number and nothing else, so
     * no recipient timezone exists anywhere to populate. Quiet hours are
     * therefore evaluated against the business's local time, which is an
     * approximation that is right for a customer in the same city and wrong
     * for one abroad. Fixing it needs a real source for a recipient's
     * timezone, not a field nothing can fill.
     */
    quietHoursTimezone: v.string(),
    scheduledFor: v.number(),
    sentAt: v.optional(v.number()),
    providerMessageId: v.optional(v.string()),
    providerName: v.optional(v.string()),
    error: v.optional(v.string()),
    attempts: v.number(),
    /** Demo/seed rows are suppressed at dispatch, not filtered at the source. */
    isDemo: v.boolean(),
    isSeed: v.boolean(),
  })
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_status_scheduledFor", ["status", "scheduledFor"])
    .index("by_client", ["clientId", "sentAt"])
    .index("by_customer", ["customerId", "sentAt"]),

  /** Approved provider templates, so a send can never reference an unapproved one. */
  messageTemplates: defineTable({
    key: v.string(),
    channel: messageChannel,
    locale: v.string(),
    body: v.string(),
    providerTemplateName: v.optional(v.string()),
    approvalStatus: v.union(v.literal("draft"), v.literal("submitted"), v.literal("approved"), v.literal("rejected")),
  }).index("by_key_channel", ["key", "channel", "locale"]),

  /** Review requests: Place-ID deep link, 90-day cooldown, gating banned. */
  reviewRequests: defineTable({
    clientId: v.id("clients"),
    customerId: v.id("customers"),
    locationId: v.id("locations"),
    bookingId: v.optional(v.id("bookings")),
    messageId: v.id("messages"),
    sentAt: v.number(),
    /** Enforces the cooldown; nothing here records or filters on rating. */
    cooldownUntil: v.number(),
  })
    .index("by_customer", ["customerId", "sentAt"])
    .index("by_client", ["clientId", "sentAt"]),

  journeys: defineTable({
    clientId: v.optional(v.id("clients")),
    name: v.string(),
    version: v.number(),
    status: v.union(v.literal("draft"), v.literal("live"), v.literal("archived")),
    graph: v.any(), // node canvas; Zod-validated at the boundary like SiteConfig
  }).index("by_client_status", ["clientId", "status"]),

  journeyEnrolments: defineTable({
    clientId: v.id("clients"),
    journeyId: v.id("journeys"),
    journeyVersion: v.number(),
    customerId: v.id("customers"),
    currentNodeId: v.string(),
    status: v.union(v.literal("active"), v.literal("completed"), v.literal("exited")),
    nextRunAt: v.optional(v.number()),
  })
    .index("by_status_nextRun", ["status", "nextRunAt"])
    .index("by_customer", ["customerId"]),
};
