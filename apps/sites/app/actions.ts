"use server";

import { headers } from "next/headers";
import { convexClient } from "@/lib/convex";
import { api } from "@cc/convex/api";

/**
 * The quote form posts through a server action, not a browser mutation.
 *
 * Two reasons, both deliberate:
 *   - no Convex client reaches the browser bundle, so a customer who wants a
 *     phone number does not download a realtime client to get one
 *   - the deployment URL stays server-side; there is no NEXT_PUBLIC_ anything
 *
 * The action forwards and nothing more. Every rule that matters — required
 * fields, which fields exist, consent, demo suppression — is re-derived from
 * the stored config inside convex/public/quote.ts, because this file runs on
 * input the browser chose.
 */
export async function submitQuoteAction(payload: {
  slug: string;
  sectionId: string;
  name: string;
  phone: string;
  email?: string;
  answers: Record<string, string>;
  consentAccepted: boolean;
}): Promise<
  | { ok: true; recorded: boolean; notice: { title: string; body: string } | null }
  | { ok: false; message: string }
> {
  const convex = convexClient();
  if (!convex) {
    return { ok: false, message: "Not connected yet. Please phone us instead." };
  }

  try {
    const userAgent = (await headers()).get("user-agent") ?? undefined;
    const result = await convex.mutation(api.public.quote.submit, { ...payload, userAgent });
    /*
     * The verdict is carried through, not discarded. The backend is the only
     * party that knows whether the submission reached anybody, and a demo
     * that answers "thanks, that is with us" leaves a real customer expecting
     * a call that is not coming.
     */
    return { ok: true, recorded: result.recorded, notice: result.notice };
  } catch (error) {
    // The customer gets a route to a human, never a stack trace. The detail
    // goes to the server log, where it is actually actionable.
    console.error("quote submit failed", error);
    const message =
      error instanceof Error && /REJECTED/.test(error.message)
        ? "Something in that form was not accepted. Check the fields and try again."
        : "That did not send. Try again, or phone us instead.";
    return { ok: false, message };
  }
}
