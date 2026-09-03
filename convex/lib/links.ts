import { ConvexError } from "convex/values";

/**
 * WHERE A LINK WE SEND POINTS.
 *
 * Every outbound link in this system resolves on the OFFICE origin —
 * `app.thecreativecurrent.co.za` — because that is the one host we control
 * end to end. A client's own domain is served by `apps/sites`, which renders
 * THAT CLIENT'S website on every hostname it answers; an invoice route there
 * would resolve at `renusolar.co.za/i/<token>` too, so our document would be
 * served under a client's brand. See the domains table in CLAUDE.md.
 *
 * AN UNSET ORIGIN IS A REFUSAL, not a relative link and not a guess.
 *
 * The alternative shapes are both worse in the same way. A relative URL in an
 * email is not a link at all — mail clients render it as text. A hard-coded
 * production fallback would send a dev deployment's test invoice to the real
 * site, pointing at a token that only exists in the dev database, and the
 * failure would surface as "the link says invalid" long after anyone could
 * connect it to a missing variable. Refusing here names the variable.
 */
export function officeOrigin(): string {
  const raw = process.env.SITE_URL?.trim();
  if (!raw) {
    throw new ConvexError({
      code: "NO_ORIGIN",
      message:
        "SITE_URL is not set on this deployment, so there is no origin to build a link " +
        "on. Set it to the office origin (http://localhost:3200 in dev, " +
        "https://app.thecreativecurrent.co.za in production).",
    });
  }
  return raw.replace(/\/+$/, "");
}

/**
 * The public, tokenised address of one invoice.
 *
 * Short on purpose: this gets read aloud over a phone and typed by hand at
 * least once in this business's life.
 */
export function invoiceViewUrl(token: string): string {
  return `${officeOrigin()}/i/${token}`;
}

/**
 * Where a newly invited client signs in.
 *
 * NOT a token link, and that is worth stating plainly because every other
 * link in this file is one. Invite tokens are minted and hashed, and nothing
 * ever reads them back: `resolveSignIn` reconciles invites by EMAIL ADDRESS
 * on every sign-in. So the invite email carries an address and an
 * instruction — sign in with this exact email — rather than a secret. A link
 * that appears to be a credential and is not would be the worse option: it
 * would still work when forwarded, for reasons its holder could not guess,
 * and it would stop working for the person who actually needed it.
 */
export function clientSignInUrl(slug: string): string {
  return `${officeOrigin()}/c/${slug}/sign-in`;
}
