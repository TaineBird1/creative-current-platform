import { internalQuery } from "./_generated/server";
import { importPKCS8, importJWK, SignJWT, jwtVerify, type JWK } from "jose";
import { LIVE_CHANNELS, sendAllowlist } from "./lib/providers";
import { paystackMode } from "./lib/paystack";
import type { Id } from "./_generated/dataModel";

/**
 * Is this deployment's auth actually configured?
 *
 * Exists because the failure it detects is silent and expensive: JWKS set to
 * malformed JSON — trivially done by a shell that rewrites quotes — makes
 * EVERY token verification fail with `AuthProviderDiscoveryFailed`. Nothing
 * errors at set time. It surfaces as "the middleware thinks nobody is signed
 * in" and "the back office says not found", which look like application bugs
 * and were debugged as such for an hour.
 *
 * THE PAIR LINE IS THE ONE THAT ANSWERS THE QUESTION. Every other line here
 * checks one value in ISOLATION — JWKS parses, the private key is a
 * well-formed PKCS8 PEM — and two individually perfect halves that do not
 * match each other is the failure this check exists for. It cannot be seen
 * from either value alone, it does not error when the variables are set, and
 * it locks out the owner, every client and every client's back office at once
 * while all three lines above it read `ok`.
 *
 * A half-rotation produces exactly that: JWKS from one keypair, the private
 * key from another. So this signs a throwaway token with the deployed private
 * key and verifies it against the deployed JWKS. Nothing else proves they
 * belong together.
 *
 * Run it after setting the vars on any deployment, and before believing that
 * a broken sign-in is your code:
 *
 *   npx convex run health:authConfig
 */

/**
 * Rebuild a PKCS8 PEM from however it is stored.
 *
 * `gen-auth-keys.mjs` writes the PEM with newlines replaced by SPACES, because
 * Convex wants a single-line value. `importPKCS8` wants the real thing back.
 * Rebuilt from the base64 body rather than by swapping spaces for newlines, so
 * it works whichever form the variable holds.
 */
function toPkcs8Pem(stored: string): string | null {
  const match = stored.match(
    /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/,
  );
  if (!match) return null;
  const body = (match[1] ?? "").replace(/\s+/g, "");
  if (!body) return null;
  const wrapped = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${wrapped.join("\n")}\n-----END PRIVATE KEY-----`;
}

/**
 * Do the deployed private key and the deployed JWKS belong to each other?
 *
 * Signs a throwaway JWT and verifies it. The token carries no claims worth
 * having, is never returned, and never leaves this function — it exists only
 * so that a real signature has to verify against a real public key.
 *
 * NO `iat` AND NO `exp`, deliberately: they would make the answer depend on
 * the clock, and this question has nothing to do with time. The token is
 * created and checked in the same breath.
 *
 * EVERY KEY IN THE SET IS TRIED, not just the first. A JWKS may legitimately
 * carry more than one during a rotation, and "the private key matches one of
 * them" is the true condition — checking only `keys[0]` would report a
 * mismatch for a perfectly working deployment mid-rotation.
 *
 * NOTHING SECRET IS RETURNED. The result is a sentence about whether two
 * values agree; neither value, nor the token, nor any part of them appears in
 * it — including in the failure paths, where an error message could otherwise
 * carry key material.
 */
async function pairStatus(
  privateKeyRaw: string | undefined,
  jwksRaw: string | undefined,
): Promise<string> {
  if (!privateKeyRaw || !jwksRaw) {
    return "UNCHECKABLE — both JWKS and JWT_PRIVATE_KEY must be set";
  }

  const pem = toPkcs8Pem(privateKeyRaw);
  if (!pem) return "UNCHECKABLE — JWT_PRIVATE_KEY is not a PKCS8 PEM";

  let keys: JWK[];
  try {
    const parsed = JSON.parse(jwksRaw);
    if (!Array.isArray(parsed?.keys) || parsed.keys.length === 0) {
      return "UNCHECKABLE — JWKS has no `keys` array";
    }
    keys = parsed.keys as JWK[];
  } catch {
    return "UNCHECKABLE — JWKS is not valid JSON";
  }

  let token: string;
  try {
    const privateKey = await importPKCS8(pem, "RS256");
    token = await new SignJWT({ sub: "health:pair-check" })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);
  } catch {
    /*
     * Deliberately not echoing the thrown message. An import failure can
     * quote the material it failed on, and this function's output is pasted
     * into terminals and tickets.
     */
    return "UNCHECKABLE — JWT_PRIVATE_KEY could not be imported as an RS256 key";
  }

  for (let i = 0; i < keys.length; i += 1) {
    try {
      const publicKey = await importJWK({ ...keys[i]!, alg: "RS256" }, "RS256");
      await jwtVerify(token, publicKey);
      return keys.length === 1
        ? "ok — a token signed with JWT_PRIVATE_KEY verifies against JWKS"
        : `ok — verifies against key ${i + 1} of ${keys.length} in JWKS`;
    } catch {
      // Try the next key; only the whole loop failing is a mismatch.
    }
  }

  return (
    "MISMATCH — JWT_PRIVATE_KEY does not match any key in JWKS. " +
    "Both are individually well-formed and sign-in WILL fail for everybody. " +
    "Set them together: node scripts/set-auth-keys.mjs"
  );
}
export const authConfig = internalQuery({
  args: {},
  handler: async () => {
    const jwks = process.env.JWKS;

    let jwksStatus: string;
    if (!jwks) {
      jwksStatus = "MISSING";
    } else {
      try {
        const parsed = JSON.parse(jwks);
        jwksStatus = Array.isArray(parsed.keys)
          ? `ok — ${parsed.keys.length} key(s)`
          : "INVALID — parsed, but has no `keys` array";
      } catch {
        // Almost always shell quote-stripping: {keys:[...]} not {"keys":[...]}.
        jwksStatus = "INVALID JSON — likely set from a shell that stripped the quotes";
      }
    }

    return {
      /*
       * FIRST, because it is the line that answers the question. The three
       * below it can all read `ok` while sign-in is comprehensively broken.
       */
      PAIR: await pairStatus(process.env.JWT_PRIVATE_KEY, process.env.JWKS),
      JWKS: jwksStatus,
      JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY
        ? process.env.JWT_PRIVATE_KEY.startsWith("-----BEGIN PRIVATE KEY-----")
          ? "ok"
          : "INVALID — not a PKCS8 PEM"
        : "MISSING",
      SITE_URL: process.env.SITE_URL ?? "MISSING",
      AUTH_RESEND_KEY: process.env.AUTH_RESEND_KEY
        ? process.env.AUTH_RESEND_KEY.startsWith("re_")
          ? `ok — ${process.env.AUTH_RESEND_KEY.length} chars`
          : "INVALID — does not start with re_"
        : "MISSING",
      AUTH_EMAIL_FROM: process.env.AUTH_EMAIL_FROM ?? "MISSING (falls back to a default)",
      CONVEX_SITE_URL: process.env.CONVEX_SITE_URL ?? "MISSING",
    };
  },
});

/**
 * Will this deployment actually send a message, and to whom?
 *
 * The allowlist defaults to sending NOBODY, which is the right default for the
 * deployment nobody configures and the wrong one to discover from a customer.
 * So it is answerable in one command rather than by reading two files:
 *
 *   npx convex run health:messagingConfig
 *
 * `sendsTo` is the line that matters. Anything other than "everybody" or a
 * list you recognise means messages are being queued and held.
 */
export const messagingConfig = internalQuery({
  args: {},
  handler: async () => {
    const allowlist = sendAllowlist();
    const key = process.env.MESSAGING_RESEND_KEY ?? process.env.AUTH_RESEND_KEY;
    const from = process.env.MESSAGING_EMAIL_FROM ?? process.env.AUTH_EMAIL_FROM;

    return {
      sendsTo:
        allowlist.mode === "open"
          ? "everybody"
          : allowlist.mode === "unset"
            ? "NOBODY — MESSAGING_ALLOWLIST is unset. Set it to a list, or to * for everybody."
            : `only: ${allowlist.entries.join(", ")}`,
      liveChannels: LIVE_CHANNELS.join(", ") || "none",
      emailProvider: key
        ? process.env.MESSAGING_RESEND_KEY
          ? "ok — its own key"
          : "ok — FALLING BACK to AUTH_RESEND_KEY; set MESSAGING_RESEND_KEY"
        : "MISSING — every email will retry five times and then fail visibly",
      emailFrom: from ?? "MISSING",
      /*
       * The From domain is a SENDING domain and may have no MX record, in
       * which case every reply to it is swallowed in silence. A booking
       * confirmation is the most replied-to message this system sends, so
       * this line is worth reading before the first real send.
       *
       * Per-client `primaryContactEmail` beats this and is not visible here;
       * this is the fallback and the answer for clients that have none.
       */
      replyToFallback:
        process.env.MESSAGING_REPLY_TO ??
        "unset — clients with no primaryContactEmail get NO reply-to, and their " +
          "messages drop the 'reply to this message' line rather than inviting one",
      note:
        "WhatsApp and SMS have no provider. Those messages are queued, logged " +
        "and recorded as not sent, never marked delivered.",
    };
  },
});

/**
 * IS ANY MONEY STUCK?
 *
 * The same shape as `messagingConfig`, and it exists for the same reason that
 * one does: this system's expensive failures are the quiet ones, and a row
 * that parks where nobody looks is indistinguishable from a system with
 * nothing wrong.
 *
 * `unattributed` is the case worth the command. A verified webhook we could
 * not tie to a client is REAL MONEY that arrived and never reached the
 * ledger — deliberately, because guessing whose it is cannot be undone. But
 * parking is only half an answer: the other half is somebody noticing, and
 * nothing was ever going to make them.
 *
 *   npx convex run health:money
 */
export const money = internalQuery({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("webhookEvents").collect();
    const stuck = events.filter((e) => e.status === "unattributed" || e.status === "refused");

    const subscriptions = await ctx.db.query("subscriptions").collect();
    const pastDue = subscriptions.filter((s) => s.status === "past_due");
    /*
     * A pending subscription with no provider reference is a checkout nobody
     * completed. Harmless one at a time, and a pile of them means the
     * checkout link is not working for anybody.
     */
    const abandoned = subscriptions.filter((s) => s.status === "pending" && !s.providerRef);

    const clientName = async (id: Id<"clients"> | undefined) =>
      id ? ((await ctx.db.get(id))?.name ?? "(client removed)") : null;

    return {
      charging: paystackMode(),
      /** The headline. Anything but zero is money that arrived and stopped. */
      stuckEvents: stuck.length,
      stuck: await Promise.all(
        stuck
          .sort((a, b) => b.receivedAt - a.receivedAt)
          .slice(0, 20)
          .map(async (e) => ({
            eventId: e.eventId,
            provider: e.provider,
            type: e.type,
            status: e.status,
            receivedAt: new Date(e.receivedAt).toISOString(),
            why: e.note ?? null,
            /*
             * The keys that arrived, never the values. Enough to see WHY it
             * could not be placed — a payload with no `data.reference` and no
             * `data.metadata` explains itself.
             */
            payloadKeys: e.payloadKeys ?? null,
            client: await clientName(e.clientId),
          })),
      ),
      pastDue: await Promise.all(
        pastDue.map(async (s) => ({
          plan: s.plan,
          amountCents: s.amountCents,
          currency: s.currency,
          client: await clientName(s.clientId),
          /* Suspension is explicit-only. Nothing here has chased them. */
          note: "past_due. Nothing chases this — dunning is not built.",
        })),
      ),
      abandonedCheckouts: abandoned.length,
      note:
        stuck.length === 0
          ? "Nothing stuck."
          : "Read `stuck`. Each row is verified money we could not place — it is " +
            "parked rather than guessed, and it stays parked until somebody acts.",
    };
  },
});

/**
 * WHAT EACH PROVIDER ACTUALLY SENDS.
 *
 * Written to settle a specific question — does Paystack's `subscription.create`
 * carry the metadata we attached at checkout? — and kept because that question
 * has a new instance every time a provider is integrated. Their documentation
 * is vague, the sample payloads are behind a login, and the honest answer has
 * always been "run it and read the logs", which means the answer belongs to
 * whoever was watching at the time.
 *
 * This makes it belong to the data instead. Key names only, so it is safe to
 * run and safe to paste into a message.
 *
 *   npx convex run health:webhookShapes
 */
export const webhookShapes = internalQuery({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("webhookEvents").collect();
    const byType = new Map<string, { seen: number; keys: Set<string> }>();

    for (const event of events) {
      const key = `${event.provider}:${event.type}`;
      const entry = byType.get(key) ?? { seen: 0, keys: new Set<string>() };
      entry.seen += 1;
      for (const k of event.payloadKeys ?? []) entry.keys.add(k);
      byType.set(key, entry);
    }

    return {
      note:
        events.length === 0
          ? "No webhooks have arrived yet. Run the flow in test mode and ask again."
          : "Key names only — never values. `carriesMetadata` is the question this was written for.",
      types: [...byType.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, entry]) => ({
          type,
          seen: entry.seen,
          /** The one that decides whether attribution can rely on metadata. */
          carriesMetadata: entry.keys.has("data.metadata"),
          carriesReference: entry.keys.has("data.reference"),
          keys: [...entry.keys].sort(),
        })),
    };
  },
});
