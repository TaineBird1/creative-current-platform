"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@cc/convex/api";
import s from "./console.module.css";

/**
 * SEED THE DEPLOYMENT WITH A WEEK TO CLICK THROUGH.
 *
 * RENDERS NOTHING unless the deployment allows seeding, and "allows" means
 * `ALLOW_DEMO_SEED` is set on the backend — not a build flag, not
 * `NODE_ENV`. Both of those are properties of the BUNDLE, and the same bundle
 * is served against dev and production; only the backend knows which database
 * it is talking to.
 *
 * So the control is absent on production rather than present-and-refusing.
 * A button that appears and then fails is a button somebody keeps pressing.
 */
export function DemoData() {
  const router = useRouter();
  const status = useQuery(api.demoSeed.status, {});
  const run = useMutation(api.demoSeed.run);
  const clear = useMutation(api.demoSeed.clear);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Undefined while loading, and `allowed: false` on production.
  if (!status?.allowed) return null;

  async function act(what: "run" | "clear") {
    setBusy(true);
    setMessage(null);
    try {
      if (what === "run") {
        const result = await run({});
        setMessage(
          `Seeded: ${result.leads} leads, ${result.invoices.join(" and ")}. Look at ${result.screens.join(", ")}.`,
        );
      } else {
        const result = await clear({});
        setMessage(
          result.ventureFound ? `Cleared ${result.deleted} rows.` : "There was nothing to clear.",
        );
      }
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className={s.disclosure}>
      <summary className={s.summary}>Demo data</summary>
      <p className={s.hint}>
        Fills this deployment with one working week — leads to call, an invoice
        part-paid, a P&amp;L with a real net, an inbox with something late. It
        is removable in full: everything lands under one venture and{" "}
        <strong>Clear</strong> deletes exactly that.
      </p>
      <p className={s.hint}>
        This control is not on production. It appears only where the backend
        sets <code>ALLOW_DEMO_SEED</code>, because the alternative is a button
        that exists everywhere and refuses in the one place it matters.
      </p>
      <div className={s.actions}>
        <button
          type="button"
          className={s.btnPrimary}
          disabled={busy || status.seeded}
          onClick={() => act("run")}
        >
          {status.seeded ? "Already seeded" : "Seed a week"}
        </button>
        <button
          type="button"
          className={s.btn}
          disabled={busy || !status.seeded}
          onClick={() => act("clear")}
        >
          Clear it
        </button>
      </div>
      {message ? <p className={s.success}>{message}</p> : null}
    </details>
  );
}
