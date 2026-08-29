import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import { normaliseEmail } from "./lib/invites";

/**
 * THE ONE-TIME BOOTSTRAP.
 *
 * `invites.inviteToPlatform` requires an existing platform owner, so the very
 * first one cannot be minted through it. This closes that loop — once.
 *
 * It refuses the moment an active platform owner exists. That matters more
 * than the convenience: an internal mutation that grants platform ownership on
 * demand is a permanent privilege-escalation tool sitting in the codebase,
 * reachable by anyone who can run `npx convex run` against the deployment.
 * Gated on "no owner yet", it disarms itself the first time it succeeds, and
 * every subsequent owner has to come through an invite from an existing one —
 * which is auditable, and revocable.
 *
 *   npx convex run bootstrap:claimPlatformOwner '{"email":"you@example.com"}'
 */
export const claimPlatformOwner = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const existingOwner = await ctx.db
      .query("platformMembers")
      .withIndex("by_active_role", (q) => q.eq("active", true).eq("role", "owner"))
      .first();

    // DELIBERATELY scoped to ACTIVE owners. If the only owner account is ever
    // lost or deactivated, this has to be usable again — otherwise the
    // platform is bricked with no recovery path.
    if (existingOwner) {
      throw new ConvexError({
        code: "ALREADY_BOOTSTRAPPED",
        message:
          "A platform owner already exists. Use invites.inviteToPlatform, " +
          "which is auditable and revocable.",
      });
    }

    const email = normaliseEmail(args.email);
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();

    if (!user) {
      throw new ConvexError({
        code: "NO_SUCH_USER",
        message: `No account for ${email}. Sign in once first, then run this.`,
      });
    }

    const existing = await ctx.db
      .query("platformMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { role: "owner", active: true });
    } else {
      await ctx.db.insert("platformMembers", {
        userId: user._id,
        role: "owner",
        active: true,
      });
    }

    // The first grant of platform ownership is exactly the event an audit log
    // exists for.
    await ctx.db.insert("auditLog", {
      actorUserId: user._id,
      action: "platform.bootstrapOwner",
      entityTable: "platformMembers",
      entityId: user._id,
      after: { role: "owner", email },
      at: Date.now(),
    });

    return { email, userId: user._id, role: "owner" as const };
  },
});
