/**
 * BEARER TOKENS, MINTED AND HASHED IN ONE PLACE.
 *
 * Three things in this codebase hand someone a secret in a URL: an invite, a
 * quote accept-link, and now an invoice view-link. All three have the same
 * two requirements and they are easy to get subtly wrong per-caller, which is
 * why there is one implementation rather than three:
 *
 *   MINT from a CSPRNG, never from anything meaningful. A token derived from
 *   an invoice number, a row id or a counter is guessable by construction —
 *   and the person guessing does not need to be clever, they need to add one.
 *   32 bytes is 256 bits; there is no useful attack on that.
 *
 *   STORE only the hash. The plaintext exists in the link and nowhere we
 *   control, so a database leak hands over no working links. That matters
 *   most for the invite, which grants a ROLE, and least for the invoice view,
 *   which exposes one document — but the cheap version is the same code, so
 *   there is no reason to reason about it per caller.
 *
 * These were previously in lib/invites.ts, which was the wrong home the
 * moment a second caller wanted them: an invoice minting something called
 * `newInviteToken` reads as a mistake even when it is not, and a name that
 * has to be explained is a name that will eventually be worked around with a
 * second copy.
 */

/** 32 random bytes, hex. The only way a token in this system is created. */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256, hex. What goes in the database; the plaintext never does. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
