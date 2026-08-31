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
    const existingUser = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();

    /*
     * CREATE the account if it does not exist. This used to demand that you
     * sign in first, which is impossible on a fresh deployment and deadlocked
     * it completely: `resolveSignIn` refuses an unknown email without a
     * pending invite, and an invite cannot be minted because `createdBy` is a
     * required `Id<"users">` and there is no user yet to attribute it to. The
     * old instruction only ever worked on a deployment whose owner account
     * predated the invite gate.
     *
     * A bare user row is exactly what `resolveSignIn` refuses to leave behind,
     * and rightly — but this one is not bare. It becomes a platform owner in
     * the same transaction, so it can reach everything the moment it exists.
     * `emailVerificationTime` is deliberately unset: the OTP flow verifies the
     * address on first sign-in, and claiming otherwise here would be a lie.
     *
     * The safety property was never "an account must already exist" — it is
     * the ACTIVE-owner check above, which disarms this the first time it runs.
     */
    const userId = existingUser?._id ?? (await ctx.db.insert("users", { email }));

    const existing = await ctx.db
      .query("platformMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { role: "owner", active: true });
    } else {
      await ctx.db.insert("platformMembers", {
        userId,
        role: "owner",
        active: true,
      });
    }

    // The first grant of platform ownership is exactly the event an audit log
    // exists for.
    await ctx.db.insert("auditLog", {
      actorUserId: userId,
      action: "platform.bootstrapOwner",
      entityTable: "platformMembers",
      entityId: userId,
      after: { role: "owner", email },
      at: Date.now(),
    });

    return { email, userId, role: "owner" as const };
  },
});
