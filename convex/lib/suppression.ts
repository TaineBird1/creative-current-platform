import type { QueryCtx } from "../_generated/server";

/**
 * SUPPRESSION FAILS CLOSED.
 *
 * This is the consent problem wearing different clothes, and it resolves the
 * same way. A missed check means phoning or messaging somebody who asked us
 * not to. That is not recoverable: the call has happened, they are angrier
 * than before, and under POPIA it is the one failure a regulator will act on.
 * Being wrongly suppressed is recoverable — someone notices a lead sitting
 * idle and removes the suppression.
 *
 * So every uncertain answer is SUPPRESSED:
 *
 *   an error while looking it up          -> suppressed
 *   a value we cannot normalise           -> suppressed
 *   no identifier to check at all         -> suppressed
 *   a partial match we cannot resolve     -> suppressed
 *
 * The last one matters most and is the least obvious. A suppression on the
 * name fragment "Coastal" against a lead called "Coastal Plumbing" is an
 * ambiguity, not a miss — a human wrote that fragment because they wanted a
 * family of businesses left alone. Requiring an exact match would let the
 * suppression list quietly stop working the moment a business trades under a
 * slightly different name.
 *
 * ONE CHOKE POINT. Every call path and every message path goes through
 * `contactDecision`, and guards.test.ts fails if anything reaches the
 * `suppressions` table directly. "Remember to check the suppression list" in
 * four callers is four places to forget, and forgetting is silent — the call
 * connects, nothing errors, and the only person who finds out is the one who
 * asked not to be contacted.
 *
 * WHY IT NEVER THROWS. A thrown error is a decision the caller makes, and
 * some caller will eventually wrap it in a try/catch that proceeds. This
 * returns a verdict instead, and the verdict is `blocked` when anything went
 * wrong, so the failure mode of ignoring it is a silent no-contact rather
 * than a silent contact.
 */

export type ContactVerdict = {
  blocked: boolean;
  /** Why, in words a human can act on. Always present when blocked. */
  reason: string;
  /** Which suppression matched, for the audit trail. */
  matched?: { kind: string; value: string };
};

export type ContactIdentifiers = {
  placeId?: string | null;
  phone?: string | null;
  domain?: string | null;
  businessName?: string | null;
};

const blocked = (reason: string, matched?: ContactVerdict["matched"]): ContactVerdict => ({
  blocked: true,
  reason,
  matched,
});

/** Digits only, so "+27 82 555 1234" and "0825551234" cannot disagree. */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // Drop a leading country code or trunk zero so the comparison is on the
  // subscriber number. Two formats of one number must not read as two people.
  return digits.replace(/^(?:0027|27|0)/, "");
}

function normaliseDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^[a-z]+:\/\//, "");
  const host = withoutScheme.split("/")[0]?.replace(/^www\./, "");
  return host && host.includes(".") ? host : null;
}

/**
 * May we contact this lead?
 *
 * Ask before EVERY call and EVERY message. The answer is a verdict, never an
 * exception, and `blocked` is the default for anything this function could
 * not establish.
 */
export async function contactDecision(
  ctx: QueryCtx,
  identifiers: ContactIdentifiers,
): Promise<ContactVerdict> {
  try {
    const placeId = identifiers.placeId?.trim();
    const rawPhone = identifiers.phone?.trim();
    const rawDomain = identifiers.domain?.trim();
    const name = identifiers.businessName?.trim();

    /*
     * Nothing to check is not the same as nothing to find. A lead with no
     * identifiers cannot be matched against the list at all, so we have no
     * evidence either way — and no evidence resolves to suppressed.
     */
    if (!placeId && !rawPhone && !rawDomain && !name) {
      return blocked("no identifier to check against the suppression list");
    }

    const rows = await ctx.db.query("suppressions").collect();

    if (placeId) {
      const hit = rows.find((row) => row.kind === "placeId" && row.value === placeId);
      if (hit) return blocked(hit.reason, { kind: hit.kind, value: hit.value });
    }

    if (rawPhone) {
      const mine = normalisePhone(rawPhone);
      if (!mine) {
        // A phone we cannot normalise is a phone we cannot clear.
        return blocked(`cannot normalise the phone "${rawPhone}" to check it`);
      }
      const hit = rows.find(
        (row) => row.kind === "phone" && normalisePhone(row.value) === mine,
      );
      if (hit) return blocked(hit.reason, { kind: hit.kind, value: hit.value });
    }

    if (rawDomain) {
      const mine = normaliseDomain(rawDomain);
      if (!mine) {
        return blocked(`cannot normalise the domain "${rawDomain}" to check it`);
      }
      const hit = rows.find((row) => {
        if (row.kind !== "domain") return false;
        const theirs = normaliseDomain(row.value);
        if (!theirs) return false;
        // A subdomain of a suppressed domain is the same business.
        return mine === theirs || mine.endsWith(`.${theirs}`);
      });
      if (hit) return blocked(hit.reason, { kind: hit.kind, value: hit.value });
    }

    if (name) {
      const haystack = name.toLowerCase();
      const hit = rows.find((row) => {
        if (row.kind !== "nameFragment") return false;
        const fragment = row.value.trim().toLowerCase();
        // A fragment is written to catch a family of names; an exact-match
        // rule would let it lapse the moment a business restyles itself.
        return fragment.length > 0 && haystack.includes(fragment);
      });
      if (hit) return blocked(hit.reason, { kind: hit.kind, value: hit.value });
    }

    return { blocked: false, reason: "no suppression matched" };
  } catch (error) {
    /*
     * THE CASE THIS FILE IS FOR. An error here means we do not know whether
     * this person asked to be left alone, and "we do not know" is not
     * permission. The alternative — letting the error propagate — leaves the
     * decision to whichever caller catches it, and one of them will proceed.
     */
    const detail = error instanceof Error ? error.message : "unknown error";
    return blocked(`suppression lookup failed (${detail}) — refusing to contact on a failed check`);
  }
}

/** Convenience for call paths that only need the boolean. */
export async function mayContact(
  ctx: QueryCtx,
  identifiers: ContactIdentifiers,
): Promise<boolean> {
  return !(await contactDecision(ctx, identifiers)).blocked;
}
