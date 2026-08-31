import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import {
  verifySignature,
  eventIdFor,
  occurredAtFor,
  WebhookRefused,
  type Provider,
} from "./lib/webhookVerify";

/**
 * PUBLIC, UNAUTHENTICATED. On the PUBLIC_ALLOWLIST in guards.test.ts.
 *
 * Auth's own routes must exist before a session does. Provider webhooks are
 * here for a different reason: they are authenticated by SIGNATURE rather
 * than by session, because the caller is Paystack's server and it has no
 * account with us.
 *
 * THE ORDER OF OPERATIONS IN THESE HANDLERS IS THE SECURITY PROPERTY.
 *
 *   1. read the RAW body as text
 *   2. verify the signature over those exact bytes
 *   3. only then parse
 *
 * Nothing before step 2 touches the payload, and `request.json()` never
 * appears in this file — a guard test enforces that. Parsing first would run
 * a parser over bytes an unauthenticated stranger sent to a discoverable URL,
 * and it re-serialises the body, so the signature would then be checked
 * against different bytes from the ones it was computed over.
 */
const http = httpRouter();
auth.addHttpRoutes(http);

const webhook = (provider: Provider) =>
  httpAction(async (ctx, request) => {
    const receivedAt = Date.now();

    // 1. Raw bytes. Not request.json().
    const rawBody = await request.text();

    try {
      // 2. Verify, or throw. There is no path past this line for an
      //    unverified body, and no "secret not configured" path that
      //    degrades to accepting one.
      await verifySignature({ provider, rawBody, headers: request.headers, now: receivedAt });
    } catch (error) {
      if (error instanceof WebhookRefused) {
        // The body is deliberately not echoed and not logged here: it is
        // unverified input from a stranger.
        return new Response(error.reason, { status: error.status });
      }
      throw error;
    }

    // 3. Now it is safe to parse.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("body is not JSON", { status: 400 });
    }

    const { eventId, derived } = await eventIdFor(provider, payload, rawBody);
    const type =
      typeof (payload as Record<string, unknown>)?.event === "string"
        ? ((payload as Record<string, unknown>).event as string)
        : typeof (payload as Record<string, unknown>)?.event_type === "string"
          ? ((payload as Record<string, unknown>).event_type as string)
          : "unknown";

    const result = await ctx.runMutation(internal.webhooks.ingest, {
      provider,
      eventId,
      type,
      /*
       * The PROVIDER's timestamp, or null. Never substituted with `now` — a
       * retry stamped now would look like the newest thing we know and would
       * overwrite a newer state.
       */
      occurredAt: occurredAtFor(payload),
      receivedAt,
      payload,
    });

    /*
     * 200 for everything the handler understood, including duplicates and
     * events we parked. A non-200 tells the provider to retry, and retrying a
     * duplicate we have already correctly ignored just produces more of them.
     */
    return Response.json({ ...result, derivedEventId: derived }, { status: 200 });
  });

http.route({ path: "/webhooks/paystack", method: "POST", handler: webhook("paystack") });
http.route({ path: "/webhooks/paddle", method: "POST", handler: webhook("paddle") });

export default http;
