import { defineTable } from "convex/server";
import { v } from "convex/values";

export const platformRole = v.union(
  v.literal("owner"),      // Taine. Everything.
  v.literal("operator"),   // staff on the platform side
  v.literal("agent"),      // commission-only; leads + demos, no money screens
);

export const tenantRole = v.union(
  v.literal("owner"),      // the client's business owner
  v.literal("manager"),    // ONE location, no prices, no billing
  v.literal("staff"),      // own calendar, no revenue
);

export const identityTables = {
  /**
   * Platform-side access. A user with no row here cannot reach /admin at all.
   * Separate table from `memberships` so a tenant role can never be mistaken
   * for a platform role by a lookup that forgot to filter.
   */
  platformMembers: defineTable({
    userId: v.id("users"),
    role: platformRole,
    active: v.boolean(),
    invitedBy: v.optional(v.id("users")),
  })
    .index("by_user", ["userId"])
    .index("by_active_role", ["active", "role"]),

  /**
   * THE tenancy authority. Every scoped read starts here, keyed by the
   * authenticated userId. No membership row => the client does not exist
   * as far as that user is concerned.
   */
  memberships: defineTable({
    userId: v.id("users"),
    clientId: v.id("clients"),
    role: tenantRole,
    /** Managers are pinned to one branch; row-scoping reads this. */
    locationId: v.optional(v.id("locations")),
    active: v.boolean(),
    invitedBy: v.optional(v.id("users")),
    acceptedAt: v.number(),
  })
    // The index the guard uses. Ordered so `by_user` alone lists a user's
    // tenants, and `by_user_client` is a single-document point read.
    .index("by_user", ["userId", "active"])
    .index("by_user_client", ["userId", "clientId"])
    .index("by_client", ["clientId", "active"]),

  /**
   * Universal invite system. Signup RECONCILES an invite into a membership —
   * there is no path that creates a bare user row with access.
   */
  invites: defineTable({
    /** Exactly one of clientId / platformRole is set. */
    clientId: v.optional(v.id("clients")),
    platformRole: v.optional(platformRole),
    tenantRole: v.optional(tenantRole),
    locationId: v.optional(v.id("locations")),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    channel: v.union(v.literal("whatsapp"), v.literal("email")),
    /** SHA-256 of the token. The plaintext token exists only in the invite link. */
    tokenHash: v.string(),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedByUserId: v.optional(v.id("users")),
    revokedAt: v.optional(v.number()),
    createdBy: v.id("users"),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_client", ["clientId"])
    .index("by_email", ["email"]),

  /**
   * Impersonation. Read-only by default; "act" mode is explicit, expires in
   * 60 minutes, and every write made under it is audit-logged with this id.
   */
  impersonationSessions: defineTable({
    platformUserId: v.id("users"),
    clientId: v.id("clients"),
    mode: v.union(v.literal("read"), v.literal("act")),
    reason: v.string(),
    startedAt: v.number(),
    expiresAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index("by_platformUser_active", ["platformUserId", "endedAt"])
    .index("by_client", ["clientId"]),
};
