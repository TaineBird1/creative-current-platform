import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  filterContactable,
  decideAgainst,
  loadSuppressions,
  normaliseDomain,
  type ContactVerdict,
} from "./suppression";
import { toE164 } from "./phone";

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

/**
 * IS THIS ADDRESS A LEAD'S?
 *
 * The reverse of everything above. The rest of this module keeps leads from
 * being CALLED without a check; this keeps them from being MESSAGED at all.
 *
 * The hole it closes: dispatch blocks demo and seed data, and a lead is
 * neither. `isDemo` and `isSeed` are DESIGNATIONS we apply to data we made up.
 * A lead is real data about a real business — the dev deployment holds 39
 * actual KZN solar installers with actual phone numbers off trade directories
 * — which is precisely why messaging one by accident is the expensive version
 * of this mistake rather than the harmless one.
 *
 * A recipient is a client's CUSTOMER. A lead is a business WE are prospecting.
 * Outreach is drafted and sent by hand, deliberately, and a transactional
 * pipeline that can reach a prospect is an outreach channel whether or not
 * anybody meant to build one. POPIA s69 treats electronic direct marketing
 * more strictly than a phone call to a listed business number, and an
 * automated booking-style email to a stranger is the worst of both: unasked
 * for, and machine-sent at whatever rate the cron runs.
 *
 * BOTH OF THE RECIPIENT'S IDENTIFIERS ARE CHECKED, not just the address this
 * particular message uses. A customer record carrying a lead's phone number IS
 * that lead, and emailing them instead does not make them somebody else — so
 * the phone goes against lead phones and the email's domain against lead
 * websites, every time, whichever channel is in play.
 *
 * FAILS CLOSED, like every other check of this shape here: an error, an
 * unreadable phone, or a domain that will not normalise all come back as
 * "cannot clear this", and dispatch refuses. Being wrongly held is a row in
 * the outbox saying why. Messaging a prospect is not undoable.
 */
export type LeadRecipientVerdict =
  | { verdict: "clear" }
  | { verdict: "lead"; reason: string }
  | { verdict: "unknown"; reason: string };

export async function recipientIsLead(
  ctx: QueryCtx,
  args: { phone?: string | null; email?: string | null },
): Promise<LeadRecipientVerdict> {
  try {
    /*
     * Whether any check actually ran. An identifier we cannot canonicalise is
     * not a lead cleared, it is a lead unchecked, and the two must not read
     * the same — so if NOTHING could be checked, this refuses.
     */
    let checked = false;

    const phone = args.phone?.trim();
    if (phone) {
      const mine = toE164(phone);
      if (!mine.ok) {
        /*
         * Skipped rather than blocked here, and this is the one place that
         * needs justifying.
         *
         * Lead phones are stored as E.164, so a number that will not
         * canonicalise cannot match one — there is no lead reachable through
         * this path to protect. And dispatch refuses such a number a few lines
         * later anyway, through `contactDecision`, which fails closed on
         * exactly this and says so in better words: a foreign customer's
         * number is a messaging limitation, not an accusation that they are a
         * prospect.
         *
         * That makes this correct ONLY while contactDecision still runs on
         * every dispatch. If it ever stops, this must go back to blocking.
         */
      } else {
        checked = true;
        const hit = await ctx.db
          .query("leads")
          .withIndex("by_phone", (q) => q.eq("phone", mine.e164))
          .first();
        if (hit) {
          return {
            verdict: "lead",
            reason:
              `that number belongs to ${hit.businessName}, a lead we are prospecting. ` +
              "Outreach is drafted and sent by hand, never through this pipeline.",
          };
        }
      }
    }

    const email = args.email?.trim();
    const at = email ? email.lastIndexOf("@") : -1;
    const domain = email && at > 0 ? normaliseDomain(email.slice(at + 1)) : null;
    /*
     * An address whose domain will not parse is skipped for the same reason as
     * an unreadable phone: it cannot match a lead website, and it is not an
     * address anything can deliver to either. `checked` is what stops that
     * from quietly becoming a pass.
     */
    if (domain) {
      checked = true;

      /*
       * A SCAN, not an index read, and that is a deliberate limit rather than
       * an oversight.
       *
       * `leads.website` holds what the directory printed — "https://www.x.co.za",
       * "x.co.za/contact" — so an exact index lookup would match some of them
       * and quietly miss the rest, which is the worst outcome available here.
       * Normalising at read time is correct and costs a collect. At 39 leads
       * that is nothing. If lead volume ever makes it matter, the fix is a
       * normalised `websiteDomain` column with its own index, written where
       * `website` is written — not a cap on this loop, which would fail open.
       */
      const leads = await ctx.db.query("leads").collect();
      const hit = leads.find((lead) => {
        if (!lead.website) return false;
        const theirs = normaliseDomain(lead.website);
        if (!theirs) return false;
        // A subdomain of a lead's domain is the same business, same rule as
        // the suppression list uses.
        return domain === theirs || domain.endsWith(`.${theirs}`);
      });
      if (hit) {
        return {
          verdict: "lead",
          reason:
            `${domain} is the website of ${hit.businessName}, a lead we are prospecting. ` +
            "Outreach is drafted and sent by hand, never through this pipeline.",
        };
      }
    }

    if (!checked) {
      /*
       * Nothing to check is not the same as nothing to find — the same
       * sentence as `decideAgainst`, and the same answer. A recipient we
       * cannot identify at all is one we cannot clear.
       */
      return {
        verdict: "unknown",
        reason:
          "no readable phone or email on this recipient, so nothing could be checked " +
          "against the lead list",
      };
    }

    return { verdict: "clear" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      verdict: "unknown",
      reason: `could not check the recipient against the lead list (${detail})`,
    };
  }
}
