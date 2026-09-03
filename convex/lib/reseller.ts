import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { patchDoc } from "./db";

/**
 * RESELLER DEPTH IS EXACTLY 1.
 *
 * A client that HAS a resellerId can never BE one. Two directions to close,
 * and both are checks, not conventions:
 *
 *   1. setReseller  -- the child must not already be somebody's reseller,
 *                      and the proposed parent must not itself have a parent.
 *   2. assertCanBecomeReseller -- called before anything points AT a client.
 *
 * Why it matters beyond tidiness: requireTenant walks memberships one hop
 * down. At depth 2 that walk silently stops being complete, and a cycle
 * (A resells B resells A) would hang the resolver on an unbounded traversal.
 * The invariant is what makes the one-hop walk correct.
 */

const conflict = (message: string) => new ConvexError({ code: "RESELLER_DEPTH", message });

/** True if any client points at this one as its reseller. */
export async function isReseller(
  ctx: QueryCtx,
  clientId: Id<"clients">,
): Promise<boolean> {
  const child = await ctx.db
    .query("clients")
    .withIndex("by_reseller", (q) => q.eq("resellerId", clientId))
    .first();
  return child !== null;
}

/** Guard for the moment a client is about to gain its first downstream client. */
export async function assertCanBecomeReseller(ctx: QueryCtx, clientId: Id<"clients">) {
  const client = await ctx.db.get(clientId);
  if (!client) throw conflict("reseller does not exist");
  if (client.resellerId) {
    throw conflict("a client that has a reseller cannot itself be one (max depth 1)");
  }
}

/** Guard for the moment a client is about to gain a parent. */
export async function assertCanHaveReseller(ctx: QueryCtx, clientId: Id<"clients">) {
  if (await isReseller(ctx, clientId)) {
    throw conflict("a client that is a reseller cannot itself have one (max depth 1)");
  }
}

/**
 * The ONLY way clients.resellerId is ever written. Both directions checked,
 * plus the self-reference case, before the patch lands.
 */
export async function setReseller(
  ctx: MutationCtx,
  clientId: Id<"clients">,
  resellerId: Id<"clients"> | null,
) {
  if (resellerId === null) {
    await patchDoc(ctx, clientId, { resellerId: undefined });
    return;
  }
  if (resellerId === clientId) throw conflict("a client cannot resell itself");

  await assertCanBecomeReseller(ctx, resellerId); // parent has no parent
  await assertCanHaveReseller(ctx, clientId); // child has no children

  await patchDoc(ctx, clientId, { resellerId });
}
