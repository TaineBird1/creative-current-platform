import { internalQuery } from "./_generated/server";
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
 * Run it after setting the vars on any deployment, and before believing that
 * a broken sign-in is your code:
 *
 *   npx convex run health:authConfig
 */
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
