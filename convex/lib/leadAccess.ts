import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { filterContactable, decideAgainst, loadSuppressions, type ContactVerdict } from "./suppression";

/**
 * THE ONLY WAY LEAD ROWS LEAVE THE BACKEND.
 *
 * SUPPRESSION FILTERS THE QUEUE, NOT THE DIAL.
 *
 * Blocking at the moment of dialling is too late by one whole step. By then
 * the name and the number are on the screen in front of a person, and a
 * person who can see a number will phone it — from their own handset, out of
 * the CRM's sight, and the block that "worked" recorded nothing and stopped
 * nobody. The refusal has to happen where the list is built, so the row is
 * never drawn at all.
 *
 * So `listContactable` is the only way to get a list of leads, it always
 * filters, and guards.test.ts fails if any other module queries the `leads`
 * table. That is a heavy rule and it is the right weight: every screen that
 * shows a callable lead is a screen someone can call from.
 *
 * THE DETAIL VIEW IS THE EXCEPTION, AND IT IS NOT A HOLE.
 *
 * `getWithVerdict` returns a suppressed lead — with its verdict attached and
 * unmissable. Hiding it would be worse: somebody chasing "why has nobody
 * contacted Coastal Plumbing" needs to find the answer, and a row that has
 * vanished sends them to re-source the same business from Places and start
 * again. Seeing "suppressed: asked not to be contacted" ends it.
 */

export type LeadWithVerdict = { lead: Doc<"leads">; verdict: ContactVerdict };

/**
 * Leads we may contact, from a candidate set. The suppression list is read
 * once for the whole batch rather than once per lead.
 *
 * `listUnavailable` is surfaced rather than swallowed: when the suppression
 * list cannot be read every lead is blocked, and the caller has to be able to
 * tell an empty queue from a broken one. See `filterContactable`.
 */
export async function listContactable(
  ctx: QueryCtx,
  candidates: readonly Doc<"leads">[],
): Promise<{ leads: Doc<"leads">[]; suppressedCount: number; listUnavailable: boolean }> {
  const result = await filterContactable(ctx, candidates, (lead) => ({
    placeId: lead.placeId,
    phone: lead.phone ?? null,
    domain: lead.website ?? null,
    businessName: lead.businessName,
  }));

  return {
    leads: result.allowed,
    suppressedCount: result.blockedCount,
    listUnavailable: result.listUnavailable,
  };
}

/**
 * One lead, with the answer to "may we call them" attached.
 *
 * The verdict travels WITH the row rather than being something the screen can
 * forget to ask for. A caller that ignores it is visibly ignoring it, which
 * is a different kind of mistake from never having been told.
 */
export async function getWithVerdict(
  ctx: QueryCtx,
  leadId: Id<"leads">,
): Promise<LeadWithVerdict | null> {
  const lead = await ctx.db.get(leadId);
  if (!lead) return null;

  let verdict: ContactVerdict;
  try {
    const rows = await loadSuppressions(ctx);
    verdict = decideAgainst(rows, {
      placeId: lead.placeId,
      phone: lead.phone ?? null,
      domain: lead.website ?? null,
      businessName: lead.businessName,
    });
  } catch (error) {
    // Same direction as everywhere else: a failed check is not permission.
    const detail = error instanceof Error ? error.message : "unknown error";
    verdict = {
      blocked: true,
      reason: `suppression check failed (${detail}) — treat as do-not-contact until it can be read`,
    };
  }

  return { lead, verdict };
}
