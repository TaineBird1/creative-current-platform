/**
 * ONE PHONE NORMALISER. THE PHONE IS A SUPPRESSION KEY.
 *
 * This exists because there were two, with different canonical forms: the
 * importer produced "+27833176385" and the suppression matcher produced
 * "833176385". They happened to agree, because the matcher normalised BOTH
 * sides at compare time — so the bug was latent rather than absent, and every
 * guard test passed.
 *
 * The failure it was one careless import away from: a path that stores a raw
 * "083 317 6385" while suppression holds "+27833176385". Nothing errors. No
 * test goes red. The lead reappears on the queue and somebody who asked not
 * to be contacted gets phoned again — which is the one failure in this whole
 * codebase that cannot be taken back.
 *
 * So there is one function, `toE164`, and guards.test.ts fails on any other
 * module that strips digits out of something called a phone.
 *
 * E.164 IS THE STORED KEY; THE ORIGINAL STRING IS KEPT FOR DISPLAY.
 * `+27833176385` is what matching and `tel:` need. "0833176385 / 0622155142"
 * is what a person recognises, and it holds the second number that
 * normalising necessarily discards — so it is kept beside the key rather than
 * thrown away.
 */

/** South Africa. The only country this list covers, and saying so is honest. */
const SA_E164 = /^\+27\d{9}$/;

export type NormalisedPhone =
  | { e164: string; display: string; ok: true }
  | { e164: null; display: string; ok: false; reason: string };

/**
 * To +27XXXXXXXXX, or a stated failure. Never a best guess.
 *
 * Returning null rather than something-shaped matters: a number this cannot
 * parse is a number we cannot match against the do-not-call list, and the
 * callers treat that as "do not contact" rather than "probably fine".
 */
export function toE164(raw: string | null | undefined): NormalisedPhone {
  const display = (raw ?? "").trim();
  if (!display) return { e164: null, display, ok: false, reason: "no number given" };

  /*
   * "0833176385 / 0622155142" and "0832070485 (WhatsApp) / 0870744449" are
   * both real rows in the campaign list. The FIRST number is the identity —
   * whoever answers it is who we reached — and the rest stays in `display`
   * rather than being silently lost.
   */
  const first = display.split(/[/,;]|\bor\b/i)[0] ?? display;

  /*
   * A parenthetical LABEL — "(WhatsApp)", "(after hours)" — is a note and is
   * dropped. A parenthetical AREA CODE — "(031) 940 3961" — is the number,
   * and dropping it silently produced a 7-digit string that then failed to
   * parse. The two are told apart by whether there is a letter inside: the
   * first version stripped both and lost a perfectly good Durban landline.
   */
  const digits = first.replace(/\([^)]*[A-Za-z][^)]*\)/g, "").replace(/\D/g, "");
  if (!digits) return { e164: null, display, ok: false, reason: "no digits in that number" };

  let e164: string;
  if (digits.startsWith("0027")) e164 = `+${digits.slice(2)}`;
  else if (digits.startsWith("27")) e164 = `+${digits}`;
  else if (digits.startsWith("0")) e164 = `+27${digits.slice(1)}`;
  else e164 = `+27${digits}`;

  if (!SA_E164.test(e164)) {
    return {
      e164: null,
      display,
      ok: false,
      // The number is quoted back so a person can fix the source row.
      reason: `"${display}" is not a South African number (got ${e164})`,
    };
  }

  return { e164, display, ok: true };
}

/**
 * Compare two numbers that may be stored in different shapes.
 *
 * A suppression row can be typed by hand in any format a person likes, and a
 * lead's key is E.164. Both sides go through the same function, and an
 * UNPARSEABLE value on either side returns false here — the caller is
 * expected to treat that as blocked, not as cleared. See lib/suppression.ts:
 * the decision about what an unknown means belongs there, not in a comparison.
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = toE164(a);
  const right = toE164(b);
  if (!left.ok || !right.ok) return false;
  return left.e164 === right.e164;
}

/**
 * The form a phone is STORED in, for tables keyed on it.
 *
 * E.164 when we can get there, which is every South African number and so
 * every number this platform has seen. When we cannot — a foreign number a
 * customer typed into a booking form — it falls back to digits rather than
 * refusing the booking, because a guest house turning away an overseas
 * guest's number is a worse failure than an imperfect key.
 *
 * WHAT THAT COSTS, stated rather than discovered: a number that does not
 * reach E.164 cannot be matched against the do-not-call list, and
 * `contactDecision` fails closed on exactly that — so a customer stored this
 * way will have messages SUPPRESSED, with a row in the outbox saying why.
 * That is the right direction (we genuinely cannot check them) and it is
 * visible, which is the only reason it is acceptable.
 */
export function toStorageKey(raw: string): string {
  const parsed = toE164(raw);
  return parsed.ok ? parsed.e164 : raw.replace(/\D/g, "");
}
