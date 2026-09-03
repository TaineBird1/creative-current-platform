"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@cc/convex/api";
import s from "./quote.module.css";

type Quote = FunctionReturnType<typeof api.public.quote.view>;

/**
 * THE ONE BUTTON, and everything that has to be true before it is pressed.
 *
 * The customer is on a phone, in a WhatsApp thread, deciding whether to spend
 * five figures. What they need is the number, what it buys, who it is from,
 * and how long it stands — then one unambiguous action. Anything else on this
 * page is competing with the decision.
 *
 * IT SAYS WHAT ACCEPTING DOES. "Accept" on its own is a word people press
 * without reading; the line under it says the business will be told and will
 * be in touch, which is what actually happens (`public/quote.accept` records
 * the acceptance and creates the job). Nobody should discover the consequence
 * afterwards.
 *
 * ACCEPTING IS FINAL AND SAYS SO. There is no undo in the backend — the quote
 * moves to accepted and a job may be created — so the button does not pretend
 * otherwise. It is the only irreversible thing on the page and it is the only
 * thing styled as primary.
 */
export function Accept({ quote, token }: { quote: Quote; token: string }) {
  const accept = useMutation(api.public.quote.accept);
  const [state, setState] = useState<"idle" | "working" | "done">(
    quote.accepted ? "done" : "idle",
  );
  const [error, setError] = useState<string | null>(null);

  if (state === "done") {
    return (
      <div className={s.accepted} role="status">
        <p className={s.acceptedTitle}>Accepted</p>
        <p className={s.acceptedBody}>
          {quote.businessName ?? "The business"} has been told. They will be in
          touch to arrange the work.
        </p>
      </div>
    );
  }

  if (!quote.acceptable) {
    /*
     * Expired or otherwise not acceptable. The reason is stated above this by
     * the page; repeating a dead button here would invite pressing it.
     */
    return null;
  }

  return (
    <div className={s.acceptBlock}>
      <button
        className={s.accept}
        type="button"
        disabled={state === "working"}
        onClick={async () => {
          setState("working");
          setError(null);
          try {
            await accept({ token });
            setState("done");
          } catch (caught) {
            const message =
              caught && typeof caught === "object" && "data" in caught
                ? (caught.data as { message?: string })?.message
                : undefined;
            setError(message ?? "That did not go through. Try again in a moment.");
            setState("idle");
          }
        }}
      >
        {state === "working" ? "Accepting…" : "Accept this quote"}
      </button>

      <p className={s.acceptNote}>
        {quote.businessName ?? "The business"} will be told straight away and
        will contact you to arrange the work. This cannot be undone here — ring
        them if anything changes.
      </p>

      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
