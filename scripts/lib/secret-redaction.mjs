import { createHash } from "node:crypto";

/**
 * KEEPING SECRET MATERIAL OUT OF stdout, stderr AND EVERY LOG DOWNSTREAM.
 *
 * Extracted from set-auth-keys.mjs so it can be tested, because it is the part
 * that failed in practice: the Convex CLI printed a private key in its own
 * error message — `error: unknown option '-----BEGIN PRIVATE KEY----- MIIEvg…'`
 * — and relaying that verbatim put it in a terminal scrollback and a chat
 * transcript within seconds.
 *
 * A secret in an error message is a secret in a log, a screenshot and a
 * support ticket. It does not matter that this one was truncated; a truncated
 * private key is still key material, and the truncation is precisely why an
 * exact-match redactor would have let it through.
 */

/**
 * How a secret may appear in output: its size and a hash prefix.
 *
 * Enough to answer "is what I read back the thing I sent?" across two lines of
 * a log, and worth nothing to anybody who obtains it. sha256 rather than a
 * cheap non-cryptographic hash, because a short digest of a known-format value
 * should not narrow a search.
 */
export const fingerprint = (value) =>
  `${value.length} chars, sha256 ${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

/** Any run of a secret at least this long is treated as the secret itself. */
const WINDOW = 24;

/**
 * Redact every run of `value` in `text` that is at least WINDOW long.
 *
 * SCANNING THE TEXT, NOT THE SECRET, and that direction is the correctness
 * argument rather than a style choice. The first version slid windows across
 * the SECRET and searched for each in the text, stepping by half a window —
 * which misses a run that straddles two steps. A 24-character run at offset 10
 * survived, and a test caught it: with window W and step S, a run is only
 * guaranteed to contain a whole window once it is W + S - 1 long, so the
 * effective threshold was 35, not the 24 the constant claimed.
 *
 * Scanning the text has no such gap. Any run of W characters in the text IS a
 * W-length text window, so it is found by construction, whatever its offset.
 * Each match is then extended as far as it still matches, so the whole run
 * goes rather than the first 24 characters of it.
 */
function scrubRuns(text, value, tag) {
  if (value.length < WINDOW || text.length < WINDOW) return text;

  const spans = [];
  for (let i = 0; i + WINDOW <= text.length; i += 1) {
    if (!value.includes(text.slice(i, i + WINDOW))) continue;
    let end = i + WINDOW;
    while (end < text.length && value.includes(text.slice(i, end + 1))) end += 1;
    spans.push([i, end]);
    i = end - 1; // The loop's own increment moves past the end.
  }

  // Backwards, so earlier offsets stay valid as the string is rewritten.
  let out = text;
  for (let k = spans.length - 1; k >= 0; k -= 1) {
    const [from, to] = spans[k];
    out = out.slice(0, from) + tag + out.slice(to);
  }
  return out;
}

/**
 * Replace every trace of `secrets` in `text` with a fingerprint.
 *
 * Three passes, and the second is the one that matters:
 *
 *   1. THE WHOLE VALUE, for a tool that echoes it intact.
 *   2. WINDOWS OF IT, for one that echoes a prefix. This is what actually
 *      happened. Twenty-four characters of a private key is not a coincidence,
 *      and it is still key material.
 *   3. STRUCTURAL PEM BLOCKS, so a key we were NOT about to send — a different
 *      one the tool happens to mention — does not pass on a technicality.
 *
 * Over-redaction is the safe direction and is deliberately not tuned away: a
 * mangled error message costs somebody a minute, and a leaked key costs a
 * rotation across every session.
 *
 * @param {string} text
 * @param {{name: string, value: string}[]} secrets
 */
export function redact(text, secrets = []) {
  let out = String(text ?? "");

  for (const { name, value } of secrets) {
    if (typeof value !== "string" || value.length === 0) continue;
    const tag = `[${name} redacted: ${fingerprint(value)}]`;

    out = out.split(value).join(tag);
    out = scrubRuns(out, value, tag);
  }

  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[private key redacted]",
  );

  /*
   * A windowed pass over a long value leaves a run of adjacent tags. Collapse
   * them so the message stays readable — the point is to keep the ERROR
   * legible while the secret is not.
   */
  return out.replace(
    /(\[[^\]]*redacted[^\]]*\][ \t]*){2,}/g,
    (match) => match.trimEnd().match(/\[[^\]]*redacted[^\]]*\]/)[0] + " ",
  );
}

/**
 * Indent child-process output for display, redacted first.
 *
 * The redaction is not optional and not a parameter: a `relay` that could be
 * called without secrets would eventually be called without them.
 */
export const relay = (text, secrets) =>
  redact(text, secrets)
    .trim()
    .split("\n")
    .map((line) => "      " + line)
    .join("\n");
