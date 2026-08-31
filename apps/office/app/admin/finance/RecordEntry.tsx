"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@cc/convex/api";
import type { Id } from "@cc/convex/dataModel";
import c from "../console.module.css";

type Venture = FunctionReturnType<typeof api.ventures.list>[number];
type VentureOption = Pick<Venture, "_id" | "name" | "currency">;

/**
 * RECORD INCOME OR AN EXPENSE.
 *
 * One form with a direction toggle rather than two forms, because the fields
 * are the same shape and two nearly-identical panels is how a console starts
 * feeling assembled rather than built.
 *
 * The amount is typed in MAJOR UNITS — rands, not cents — and converted once,
 * here, at the boundary. Asking a human to type 150000 for R1 500 is how a
 * ledger acquires an entry three orders of magnitude wrong. The conversion
 * rounds to a whole cent and the server asserts integer-ness again, so a
 * fractional input is refused rather than silently truncated.
 *
 * The client list is filtered to the chosen venture, because the server
 * refuses a client from another one. Offering a choice the server will reject
 * is a form that lies about what is possible.
 */
export function RecordEntry({
  ventures,
  isOwner,
  defaultDate,
}: {
  ventures: VentureOption[];
  isOwner: boolean;
  defaultDate: string;
}) {
  const router = useRouter();
  const recordIncome = useMutation(api.income.record);
  const createExpense = useMutation(api.expenses.create);

  const [direction, setDirection] = useState<"income" | "expense">("income");
  const [ventureId, setVentureId] = useState<string>(ventures[0]?._id ?? "");
  const [clientId, setClientId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const venture = ventures.find((v) => v._id === ventureId);

  // Only this venture's clients, since the server refuses any other.
  const clients = useQuery(
    api.clients.list,
    ventureId ? { ventureId: ventureId as Id<"ventures"> } : "skip",
  );

  const parsedMajor = Number(amount.replace(/[\s,]/g, ""));
  const amountValid = amount.trim() !== "" && Number.isFinite(parsedMajor) && parsedMajor > 0;
  const canSubmit =
    isOwner && !busy && amountValid && description.trim() !== "" && Boolean(venture) &&
    (direction === "income" || category.trim() !== "");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || !venture) return;

    setBusy(true);
    setError(null);
    setDone(null);

    // Major units in, whole cents out. Rounded once, here.
    const amountCents = Math.round(parsedMajor * 100);
    const at = Date.parse(`${date}T12:00:00Z`);

    try {
      if (direction === "income") {
        await recordIncome({
          ventureId: venture._id,
          clientId: clientId ? (clientId as Id<"clients">) : undefined,
          type: "payment_received",
          amountCents,
          currency: venture.currency,
          occurredAt: at,
          description: description.trim(),
        });
      } else {
        await createExpense({
          ventureId: venture._id,
          clientId: clientId ? (clientId as Id<"clients">) : undefined,
          description: description.trim(),
          category: category.trim(),
          amountCents,
          currency: venture.currency,
          incurredAt: at,
        });
      }
      setDone(`Recorded ${direction === "income" ? "income" : "expense"}.`);
      setAmount("");
      setDescription("");
      setCategory("");
      // The statement above is server-rendered and will not know about this.
      router.refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        /CLIENT_VENTURE_MISMATCH/.test(message)
          ? "That client belongs to a different venture. Pick one from this venture, or leave it blank."
          : /BAD_MONEY/.test(message)
            ? "The amount must be a positive figure in whole cents. Enter it in rands, e.g. 1500.00."
            : /FORBIDDEN|UNAUTHENTICATED/.test(message)
              ? "Recording money is owner-tier."
              : "Could not record it. Nothing was saved — try again, and check the Convex logs if it repeats.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className={c.disclosure}>
      <summary className={c.summary}>Record income or an expense</summary>

      <form className={c.form} onSubmit={submit}>
        <div className={c.fieldRow}>
          <div className={c.field}>
            <label className={c.label} htmlFor="fin-direction">
              Direction
            </label>
            <select
              id="fin-direction"
              className={c.select}
              value={direction}
              onChange={(e) => setDirection(e.target.value as "income" | "expense")}
              disabled={busy || !isOwner}
            >
              <option value="income">Money in</option>
              <option value="expense">Money out</option>
            </select>
          </div>

          <div className={c.field}>
            <label className={c.label} htmlFor="fin-venture">
              Venture
            </label>
            <select
              id="fin-venture"
              className={c.select}
              value={ventureId}
              onChange={(e) => {
                setVentureId(e.target.value);
                // The old client belongs to the old venture; the server would
                // refuse it, so drop it rather than carry an invalid choice.
                setClientId("");
              }}
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

        <div className={c.fieldRow}>
          <div className={c.field}>
            <label className={c.label} htmlFor="fin-amount">
              Amount {venture ? <span className={c.optional}>{venture.currency}</span> : null}
            </label>
            <input
              id="fin-amount"
              className={c.input}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy || !isOwner}
              inputMode="decimal"
              placeholder="1500.00"
              required
            />
          </div>

          <div className={c.field}>
            <label className={c.label} htmlFor="fin-date">
              Date
            </label>
            <input
              id="fin-date"
              type="date"
              className={c.input}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={busy || !isOwner}
              required
            />
          </div>
        </div>

        <div className={c.fieldRow}>
          <div className={c.field}>
            <label className={c.label} htmlFor="fin-description">
              Description
            </label>
            <input
              id="fin-description"
              className={c.input}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy || !isOwner}
              placeholder={direction === "income" ? "Retainer, August" : "Fibre line"}
              required
            />
          </div>

          {direction === "expense" ? (
            <div className={c.field}>
              <label className={c.label} htmlFor="fin-category">
                Category
              </label>
              <input
                id="fin-category"
                className={c.input}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={busy || !isOwner}
                placeholder="Connectivity"
                required
              />
            </div>
          ) : (
            <div className={c.field}>
              <label className={c.label} htmlFor="fin-client">
                Client <span className={c.optional}>optional</span>
              </label>
              <select
                id="fin-client"
                className={c.select}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={busy || !isOwner || clients === undefined}
              >
                <option value="">— none —</option>
                {(clients ?? []).map((client) => (
                  <option key={client._id} value={client._id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className={c.actions}>
          <button className={`${c.btn} ${c.btnPrimary}`} type="submit" disabled={!canSubmit}>
            {busy ? "Recording…" : "Record"}
          </button>
          <p aria-live="polite" className={error ? c.error : c.success}>
            {error ?? done ?? ""}
          </p>
        </div>

        {!isOwner ? (
          <p className={c.hint}>Recording money is owner-tier.</p>
        ) : null}
      </form>
    </details>
  );
}
