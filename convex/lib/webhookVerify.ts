/**
 * SIGNATURE VERIFICATION. NOTHING ELSE HAPPENS FIRST.
 *
 * The handler receives the RAW body as text and verifies it before anything
 * parses it. That order is not fussiness: `request.json()` runs a parser over
 * bytes an unauthenticated stranger sent, and a webhook endpoint's URL is
 * discoverable. It also destroys the exact bytes the signature was computed
 * over, so a re-serialised body can fail to verify for reasons that look like
 * a wrong secret and are not.
 *
 * A MISSING SECRET IS A REFUSAL, NEVER A SKIP.
 *
 * This is the failure worth being loudest about. The tempting shape is:
 *
 *     if (!secret) return true;   // "not configured yet"
 *
 * which turns an unconfigured deployment into one that accepts forged
 * payments from anybody who finds the URL, and does it silently — the
 * endpoint returns 200 and the ledger fills with money nobody sent. So a
 * missing secret throws, the request 500s, and the provider's own retry queue
 * holds the events until someone configures it. Applying the meta-rule: a
 * webhook we rejected is recoverable, because the provider retries for hours
 * and the dashboard shows the failures. A forged payment we accepted is not.
 */

export type Provider = "paystack" | "paddle";

export class WebhookRefused extends Error {
  constructor(
    readonly reason: string,
    /** 401 for a bad signature; 500 when WE are misconfigured. */
    readonly status: number,
  ) {
    super(reason);
  }
}

const enc = new TextEncoder();

async function hmacHex(algorithm: "SHA-256" | "SHA-512", secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant time, on purpose. `a === b` on hex strings returns as soon as two
 * characters differ, and that timing is measurable across enough requests —
 * it lets an attacker discover a valid signature one nibble at a time. The
 * length check leaking is fine; the length is not the secret.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function secretFor(provider: Provider): string {
  const name = provider === "paystack" ? "PAYSTACK_SECRET_KEY" : "PADDLE_WEBHOOK_SECRET";
  const secret = process.env[name];
  if (!secret) {
    /*
     * 500, not 401. This is our fault, and the distinction matters to the
     * provider: a 401 tells Paystack the event was rejected and may stop the
     * retries, while a 500 keeps them coming until we fix the config.
     */
    throw new WebhookRefused(`${name} is not set — refusing to accept unverified webhooks`, 500);
  }
  return secret;
}

/** Paddle rejects replays outside this window; Paystack has no timestamp to check. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify a raw body against its header. Throws WebhookRefused; never returns
 * false, so a caller cannot forget to check the return value.
 */
export async function verifySignature(input: {
  provider: Provider;
  rawBody: string;
  headers: Headers;
  now: number;
}): Promise<void> {
  const secret = secretFor(input.provider);

  if (input.provider === "paystack") {
    // HMAC-SHA512 of the raw body, hex, in x-paystack-signature.
    const header = input.headers.get("x-paystack-signature");
    if (!header) throw new WebhookRefused("missing x-paystack-signature", 401);
    const expected = await hmacHex("SHA-512", secret, input.rawBody);
    if (!timingSafeEqual(header.trim().toLowerCase(), expected)) {
      throw new WebhookRefused("signature does not match", 401);
    }
    return;
  }

  // Paddle: "Paddle-Signature: ts=<unix>;h1=<hex>", signing `${ts}:${body}`.
  const header = input.headers.get("paddle-signature");
  if (!header) throw new WebhookRefused("missing paddle-signature", 401);

  const parts = new Map(
    header.split(";").map((part) => {
      const [k, ...rest] = part.split("=");
      return [k?.trim() ?? "", rest.join("=").trim()] as const;
    }),
  );
  const ts = parts.get("ts");
  const h1 = parts.get("h1");
  if (!ts || !h1) throw new WebhookRefused("malformed paddle-signature", 401);

  /*
   * Replay window. Without it a signature captured once stays valid forever,
   * so anyone who ever sees one valid request can resend it indefinitely —
   * and every resend of a charge.success is a duplicate payment attempt. The
   * event-id check catches those too; this is the second lock on the door.
   */
  const signedAt = Number(ts) * 1000;
  if (!Number.isFinite(signedAt) || Math.abs(input.now - signedAt) > MAX_SKEW_MS) {
    throw new WebhookRefused("signature timestamp outside the replay window", 401);
  }

  const expected = await hmacHex("SHA-256", secret, `${ts}:${input.rawBody}`);
  if (!timingSafeEqual(h1.toLowerCase(), expected)) {
    throw new WebhookRefused("signature does not match", 401);
  }
}

/**
 * The provider's own event id, which is the whole basis of idempotency.
 *
 * Paddle always sends `event_id`. Paystack's payload carries an `id` on newer
 * integrations and, on some event types, only inside `data`. When neither is
 * present we fall back to a hash of the exact bytes received.
 *
 * That fallback is weaker and the difference is worth being precise about: it
 * detects a byte-identical REDELIVERY, which is what a retry is, and it
 * cannot tell two genuinely separate identical charges apart. Preferring it
 * to inventing a random id is the meta-rule again — a wrongly-suppressed
 * second charge shows up as a client querying a missing payment, which is
 * recoverable, and it is caught the moment the provider sends a real id.
 */
export async function eventIdFor(provider: Provider, body: unknown, rawBody: string) {
  const record = (body ?? {}) as Record<string, unknown>;
  const data = (record.data ?? {}) as Record<string, unknown>;

  const candidate =
    provider === "paddle"
      ? record.event_id
      : (record.id ?? data.id ?? record.event_id);

  if (typeof candidate === "string" && candidate.length > 0) {
    return { eventId: candidate, derived: false as const };
  }
  if (typeof candidate === "number") {
    return { eventId: String(candidate), derived: false as const };
  }

  const digest = await crypto.subtle.digest("SHA-256", enc.encode(rawBody));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { eventId: `body:${hex}`, derived: true as const };
}

/**
 * When the provider says it happened — NOT when it reached us.
 *
 * Every field here is the provider's. If none is present the event carries no
 * opinion about its own age, and the caller treats it as unorderable rather
 * than stamping it with `now`: stamping it would make a three-hour-old retry
 * look like the newest thing we know and let it overwrite a newer state.
 */
export function occurredAtFor(body: unknown): number | null {
  const record = (body ?? {}) as Record<string, unknown>;
  const data = (record.data ?? {}) as Record<string, unknown>;
  const raw =
    record.occurred_at ?? record.created_at ?? data.paid_at ?? data.created_at ?? data.paidAt;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const ms = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}
