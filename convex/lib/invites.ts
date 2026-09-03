import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { deleteDoc, patchDoc } from "./db";

/**
 * INVITE RECONCILIATION — the mechanism behind "no bare user rows".
 *
 * Convex Auth creates the user row. We cannot stop it creating one, so the
 * gate is placed at the only moment a user comes into existence
 * (`createOrUpdateUser` in auth.ts) and it refuses outright unless the email
 * has been invited or already has access.
 *
 * "No bare user rows" therefore means, precisely: a `users` document only
 * exists alongside at least one `memberships` or `platformMembers` row, and
 * every scoped function derives its tenant from those. A user with neither
 * reaches nothing, which convex/tenancy.test.ts already proves.
 */

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/**
 * Tokens are stored hashed. The plaintext exists only inside the invite link,
 * so a database leak does not hand over working invites — and an invite grants
 * a role, which makes it worth the four lines.
 *
 * The implementation moved to lib/tokens.ts when the invoice view-link became
 * the third caller. Re-exported here so every existing import keeps working
 * and there is still exactly one implementation.
 */
export { hashToken } from "./tokens";
export { newToken as newInviteToken } from "./tokens";

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function usable(invite: Doc<"invites">, now: number): boolean {
  return !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > now;
}

/** Every live invite for this email. */
export async function pendingInvitesFor(
  ctx: QueryCtx,
  email: string,
): Promise<Doc<"invites">[]> {
  const now = Date.now();
  const invites = await ctx.db
    .query("invites")
    .withIndex("by_email", (q) => q.eq("email", normaliseEmail(email)))
    .collect();
  return invites.filter((invite) => usable(invite, now));
}

/** Does this email already have access? A returning user needs no invite. */
export async function hasExistingAccess(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId).eq("active", true))
    .first();
  if (membership) return true;

  const platform = await ctx.db
    .query("platformMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return Boolean(platform?.active);
}

/**
 * Turn every live invite for this email into real access.
 *
 * Runs on EVERY sign-in, not only on user creation. An existing user who is
 * later invited to a second client would otherwise sign in through the
 * "returning user" path and never have that invite applied — a bug that looks
 * exactly like a broken invite email.
 */
export async function reconcileInvites(
  ctx: MutationCtx,
  userId: Id<"users">,
  email: string,
): Promise<number> {
  const invites = await pendingInvitesFor(ctx, email);
  const now = Date.now();
  let applied = 0;

  for (const invite of invites) {
    if (invite.clientId && invite.tenantRole) {
      const existing = await ctx.db
        .query("memberships")
        .withIndex("by_user_client", (q) =>
          q.eq("userId", userId).eq("clientId", invite.clientId!),
        )
        .unique();

      if (existing) {
        await patchDoc(ctx, existing._id, {
          role: invite.tenantRole,
          locationId: invite.locationId,
          active: true,
        });
      } else {
        await ctx.db.insert("memberships", {
          userId,
          clientId: invite.clientId,
          role: invite.tenantRole,
          locationId: invite.locationId,
          active: true,
          invitedBy: invite.createdBy,
          acceptedAt: now,
        });
      }
      applied++;
    }

    if (invite.platformRole) {
      const existing = await ctx.db
        .query("platformMembers")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      if (existing) {
        await patchDoc(ctx, existing._id, { role: invite.platformRole, active: true });
      } else {
        await ctx.db.insert("platformMembers", {
          userId,
          role: invite.platformRole,
          active: true,
          invitedBy: invite.createdBy,
        });
      }
      applied++;
    }

    // Single use. Marked accepted whether or not it granted anything, so a
    // malformed invite cannot be replayed.
    await patchDoc(ctx, invite._id, { acceptedAt: now, acceptedByUserId: userId });
  }

  return applied;
}

export const noInvite = () =>
  new ConvexError({
    code: "NOT_INVITED",
    message: "This platform is invite-only. Ask the person who set up your account.",
  });

/**
 * THE GATE, as a plain function.
 *
 * auth.ts calls this from `createOrUpdateUser`. It lives here rather than
 * inline in the callback so it can be tested directly — the callback is not
 * reachable from convex-test, and "invite-only" is exactly the rule that must
 * never be taken on trust.
 *
 * Returns the userId to sign in as, or throws. It never returns having
 * created a user that cannot reach anything.
 */
export async function resolveSignIn(
  ctx: MutationCtx,
  args: { existingUserId: Id<"users"> | null; email: string | null },
): Promise<Id<"users">> {
  if (!args.email) throw noInvite();
  const email = normaliseEmail(args.email);

  const known =
    args.existingUserId ??
    (
      await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .unique()
    )?._id ??
    null;

  if (known) {
    // A returning user still gets reconciled: an invite to a SECOND client
    // would otherwise never apply, which looks exactly like a broken email.
    await reconcileInvites(ctx, known, email);
    if (!(await hasExistingAccess(ctx, known))) throw noInvite();
    return known;
  }

  // Brand new. No invite means nothing is written at all.
  const invites = await pendingInvitesFor(ctx, email);
  if (invites.length === 0) throw noInvite();

  const userId = await ctx.db.insert("users", {
    email,
    emailVerificationTime: Date.now(),
  });

  const applied = await reconcileInvites(ctx, userId, email);
  if (applied === 0) {
    // The invite existed but granted nothing. Rather than leave the bare user
    // row this whole function exists to prevent, undo it.
    await deleteDoc(ctx, userId);
    throw noInvite();
  }

  return userId;
}
