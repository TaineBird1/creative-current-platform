"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@cc/convex/api";
import s from "./console.module.css";

/*
 * DERIVED from the query, not hand-written. The first cut spelled the
 * currency union out and missed NAD and BWP — a KZN business trades across
 * the border — so the build failed on a list the schema already owned.
 * Deriving means a new currency breaks this file loudly instead of drifting.
 */
type Venture = FunctionReturnType<typeof api.ventures.list>[number];
type VentureOption = Pick<Venture, "_id" | "name" | "currency">;

/**
 * ADD AN EXTERNAL CLIENT.
 *
 * Consulting and side work: invoices, tasks and a timeline through the same
 * ledger as everyone else, but no public site, no back office, no
 * subscription. That distinction is enforced in the mutation, not here — a
 * form is a convenience, never a security boundary.
 *
 * Inline disclosure rather than a modal. The owner is adding a record, not
 * being interrupted; there is no focus to protect, and a modal would be habit
 * rather than a decision. `<details>` also brings keyboard and screen-reader
 * behaviour we would otherwise have to rebuild.
 */
export function NewExternalClient({
  ventures,
  isOwner,
}: {
  ventures: VentureOption[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const createExternal = useMutation(api.clients.createExternal);

  const [ventureId, setVentureId] = useState<string>(ventures[0]?._id ?? "");
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const venture = ventures.find((v) => v._id === ventureId);
  const canSubmit = isOwner && !busy && name.trim().length > 0 && ventureId !== "";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || !venture) return;

    setBusy(true);
    setError(null);
    setAdded(null);

    try {
      const result = await createExternal({
        ventureId: venture._id,
        name: name.trim(),
        currency: venture.currency,
        primaryContactName: contactName.trim() || undefined,
        primaryContactEmail: contactEmail.trim() || undefined,
      });
      setAdded(result.name);
      setName("");
      setContactName("");
      setContactEmail("");
      /*
       * The list above is server-rendered, so it will not know about this
       * until the route data is refetched. Without it the owner adds a client
       * and watches nothing happen, which reads as a failed save.
       */
      router.refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      /*
       * Name the problem AND the recovery. The owner is often on a call; a
       * bare "failed" makes them guess in front of a client.
       */
      setError(
        /VENTURE_ARCHIVED/.test(message)
          ? `${venture.name} is archived. Restore it before adding clients to it.`
          : /NO_SUCH_VENTURE/.test(message)
            ? "That venture no longer exists. Reload the page and try again."
            : /FORBIDDEN|UNAUTHENTICATED/.test(message)
              ? "Only the platform owner can add a client. Ask Taine to run it."
              : "Could not add the client. Nothing was saved — try again, and if it repeats, check the Convex logs.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className={s.disclosure}>
      <summary className={s.summary}>Add an external client</summary>

      <form className={s.form} onSubmit={submit}>
        <p className={s.hint}>
          Consulting or side work. They get invoices, tasks and a timeline
          through the same ledger — no website, no back office, no
          subscription.
        </p>

        <div className={s.fieldRow}>
          <div className={s.field}>
            <label className={s.label} htmlFor="ext-name">
              Client name
            </label>
            <input
              id="ext-name"
              className={s.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy || !isOwner}
              required
              autoComplete="organization"
              placeholder="Zenith Freight"
            />
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="ext-venture">
              Venture
            </label>
            <select
              id="ext-venture"
              className={s.select}
              value={ventureId}
              onChange={(e) => setVentureId(e.target.value)}
              disabled={busy || !isOwner}
            >
              {ventures.map((v) => (
                <option key={v._id} value={v._id}>
                  {v.name} · {v.currency}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={s.fieldRow}>
          <div className={s.field}>
            <label className={s.label} htmlFor="ext-contact">
              Contact <span className={s.optional}>optional</span>
            </label>
            <input
              id="ext-contact"
              className={s.input}
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              disabled={busy || !isOwner}
              autoComplete="name"
            />
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="ext-email">
              Email <span className={s.optional}>optional</span>
            </label>
            <input
              id="ext-email"
              type="email"
              className={s.input}
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              disabled={busy || !isOwner}
              autoComplete="email"
            />
          </div>
        </div>

        <div className={s.actions}>
          <button className={`${s.btn} ${s.btnPrimary}`} type="submit" disabled={!canSubmit}>
            {busy ? "Adding…" : "Add client"}
          </button>

          {/* Live region: the outcome must reach a screen reader too. */}
          <p aria-live="polite" className={error ? s.error : s.success}>
            {error ?? (added ? `${added} added.` : "")}
          </p>
        </div>

        {!isOwner ? (
          <p className={s.hint}>
            Adding a client is owner-tier. A venture is a reporting boundary,
            so an operator cannot move work into or out of one.
          </p>
        ) : null}
      </form>
    </details>
  );
}
