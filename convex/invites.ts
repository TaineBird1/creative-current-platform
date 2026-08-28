import { v, ConvexError } from "convex/values";
import { platformMutation, tenantMutation, tenantQuery } from "./lib/functions";
import { auditWrite } from "./lib/tenancy";
import {
  INVITE_TTL_MS,
  hashToken,
  newInviteToken,
  normaliseEmail,
} from "./lib/invites";

/**
 * MINTING INVITES.
 *
 * The rule from the spec is "minting only below your own", and it is enforced
 * here rather than trusted to the UI, because an invite is how privilege is
 * created — a client owner who could mint another owner has effectively taken
 * the account, and a manager who could mint a manager has taken the branch.
 *
 * The returned token is the ONLY time the plaintext exists. Nothing stores it.
 */

const TENANT_RANK = { staff: 1, manager: 2, owner: 3 } as const;
type TenantRole = keyof typeof TENANT_RANK;

const forbidden = (message: string) => new ConvexError({ code: "FORBIDDEN", message });

const tenantRoleValidator = v.union(
  v.literal("owner"),
  v.literal("manager"),
  v.literal("staff"),
);

/** A client owner or manager invites someone into their own business. */
export const inviteToClient = tenantMutation("manager")({
  args: {
    email: v.string(),
    role: tenantRoleValidator,
    locationId: v.optional(v.id("locations")),
    channel: v.union(v.literal("whatsapp"), v.literal("email")),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const mine = TENANT_RANK[ctx.tenant.role];
    const theirs = TENANT_RANK[args.role as TenantRole];

    // STRICTLY below. An owner cannot mint an owner; a manager cannot mint a
    // manager. Otherwise privilege is a fixed point and never decays.
    if (theirs >= mine) {
      throw forbidden(`A ${ctx.tenant.role} cannot invite a ${args.role}`);
    }

    // A manager is pinned to one branch and can only staff that branch.
    if (ctx.tenant.role === "manager") {
      if (!ctx.tenant.locationId) throw forbidden("This manager has no branch assigned");
      if (args.locationId && args.locationId !== ctx.tenant.locationId) {
        throw forbidden("A manager can only invite to their own branch");
      }
    }

    const locationId =
      ctx.tenant.role === "manager" ? ctx.tenant.locationId ?? undefined : args.locationId;

    if (locationId) {
      const location = await ctx.db.get(locationId);
      if (!location || location.clientId !== ctx.tenant.clientId) {
        throw forbidden("That branch is not part of this business");
      }
    }

    const token = newInviteToken();
    const inviteId = await ctx.db.insert("invites", {
      clientId: ctx.tenant.clientId,
      tenantRole: args.role,
      locationId,
      email: normaliseEmail(args.email),
      phone: args.phone,
      channel: args.channel,
      tokenHash: await hashToken(token),
      expiresAt: Date.now() + INVITE_TTL_MS,
      createdBy: ctx.tenant.userId,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "invite.create",
      entityTable: "invites",
      entityId: inviteId,
      after: { role: args.role, email: normaliseEmail(args.email) },
    });

    // Returned once, never stored in plaintext. The caller sends it; this
    // codebase has no bulk sender, per the standing outreach rule.
    return { inviteId, token, expiresAt: Date.now() + INVITE_TTL_MS };
  },
});

export const listForClient = tenantQuery("manager")({
  args: {},
  handler: async (ctx) => {
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_client", (q) => q.eq("clientId", ctx.tenant.clientId))
      .collect();
    const now = Date.now();
    // tokenHash never leaves the server, not even hashed.
    return invites.map(({ tokenHash: _hash, ...rest }) => ({
      ...rest,
      state: rest.acceptedAt
        ? ("accepted" as const)
        : rest.revokedAt
          ? ("revoked" as const)
          : rest.expiresAt < now
            ? ("expired" as const)
            : ("pending" as const),
    }));
  },
});

export const revoke = tenantMutation("manager")({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const invite = await ctx.db.get(inviteId);
    if (!invite || invite.clientId !== ctx.tenant.clientId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Not found" });
    }
    if (invite.acceptedAt) throw forbidden("That invite has already been used");

    await ctx.db.patch(inviteId, { revokedAt: Date.now() });
    await auditWrite(ctx, ctx.tenant, {
      action: "invite.revoke",
      entityTable: "invites",
      entityId: inviteId,
    });
  },
});

/**
 * Platform-side invites: operators, agents, and the first owner of a client
 * during onboarding. Owner-tier only.
 */
export const inviteToPlatform = platformMutation({
  args: {
    email: v.string(),
    role: v.union(v.literal("operator"), v.literal("agent")),
  },
  handler: async (ctx, args) => {
    if (ctx.platform.role !== "owner") {
      throw forbidden("Only the platform owner can mint platform access");
    }
    const token = newInviteToken();
    const inviteId = await ctx.db.insert("invites", {
      platformRole: args.role,
      email: normaliseEmail(args.email),
      channel: "email",
      tokenHash: await hashToken(token),
      expiresAt: Date.now() + INVITE_TTL_MS,
      createdBy: ctx.platform.userId,
    });
    return { inviteId, token };
  },
});

/** Onboarding: the platform mints the FIRST owner of a client. */
export const inviteClientOwner = platformMutation({
  args: { clientId: v.id("clients"), email: v.string() },
  handler: async (ctx, args) => {
    const client = await ctx.db.get(args.clientId);
    if (!client) throw new ConvexError({ code: "NOT_FOUND", message: "Not found" });

    const token = newInviteToken();
    const inviteId = await ctx.db.insert("invites", {
      clientId: args.clientId,
      tenantRole: "owner",
      email: normaliseEmail(args.email),
      channel: "whatsapp",
      tokenHash: await hashToken(token),
      expiresAt: Date.now() + INVITE_TTL_MS,
      createdBy: ctx.platform.userId,
    });
    return { inviteId, token };
  },
});
