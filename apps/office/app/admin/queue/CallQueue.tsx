"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@cc/convex/api";
import { quickPresets, dayGrid } from "@/lib/callback-presets";
import s from "./queue.module.css";

/*
 * DERIVED from the query. The row shape belongs to convex/queue.ts, and a
 * hand-written copy here is a copy that drifts on the first field added.
 */
type Queue = FunctionReturnType<typeof api.queue.today>;
type Row = Queue["rows"][number];

/**
 * TODAY'S QUEUE — the thin version, built to be used from a phone.
 *
 * Deliberately not Call Mode. No keyboard shortcuts, no template composer, no
 * best-time learning: all of that is a guess about a job nobody has done
 * twenty times yet. The list, a number that dials, and four buttons that
 * write back. What is missing will announce itself after the first afternoon
 * of calls, and then it will be a decision instead of a guess.
 *
 * ONE LEAD ON SCREEN AT A TIME. A scrolling list is a desktop pattern: it
 * assumes you are choosing what to work on. Standing up with a phone you are
 * not choosing, you are working down — and a list means finding your place
 * again after every call, which is the friction that stops people at eleven.
 *
 * THE ACTIONS ARE AT THE BOTTOM because that is where a thumb is. The
 * information is at the top where the eye is, and the two do not compete.
 */
export function CallQueue({ initial }: { initial: Queue }) {
  const record = useMutation(api.queue.disposition);
  const buildDemo = useMutation(api.demos.createForLead);

  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callbackFor, setCallbackFor] = useState<string | null>(null);
  /** Open the full day grid. Closed by default: four buttons cover most calls. */
  const [pickingDay, setPickingDay] = useState(false);
  /*
   * The demo link, once built. Held in state rather than navigated to,
   * because the moment it is needed is mid-call — "can you show me?" — and
   * leaving the queue to fetch a link loses your place in it.
   */
  const [demoPath, setDemoPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const lead = rows[index];
  const done = initial.rows.length - rows.length;

  async function disposition(
    outcome: "no_answer" | "voicemail" | "meeting_set" | "not_interested" | "wrong_number",
  ) {
    if (!lead || busy) return;
    setBusy(true);
    setError(null);
    try {
      await record({ leadId: lead.leadId, outcome });
      /*
       * Removed from the local list rather than re-fetched. A re-fetch
       * re-sorts, and a queue that reshuffles under your thumb between calls
       * is a queue you lose your place in.
       */
      setRows((prev) => prev.filter((row) => row.leadId !== lead.leadId));
      setIndex((prev) => Math.min(prev, rows.length - 2 < 0 ? 0 : rows.length - 2));
      // The next lead gets a clean card.
      setDemoPath(null);
      setCopied(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveCallback(at: number) {
    if (!lead) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * Local wall-clock, which is the timezone the callback was agreed in.
       * Caller and business are both in KZN — see lib/callback-presets.ts for
       * why this is NOT the site-timezone rule messaging uses.
       */
      await record({ leadId: lead.leadId, outcome: "callback", callbackAt: at });
      setRows((prev) => prev.filter((row) => row.leadId !== lead.leadId));
      setCallbackFor(null);
      setPickingDay(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /*
   * THE STATE THAT MATTERS MOST. An empty queue and a broken one look
   * identical, and only one of them means you are finished — so the backend
   * reports which, and this says so plainly rather than showing a tidy
   * "all done" over a suppression list it could not read.
   */
  if (initial.listUnavailable) {
    return (
      <section className={s.stop} role="alert">
        <h2 className={s.stopTitle}>The do-not-call list could not be read.</h2>
        <p className={s.stopBody}>
          The queue is empty because nothing can be cleared for calling, not
          because there is nobody to call. Do not work from another list — some
          of these businesses have asked not to be contacted, and right now we
          cannot tell which.
        </p>
      </section>
    );
  }

  if (!lead) {
    return (
      <section className={s.stop}>
        <h2 className={s.stopTitle}>{done > 0 ? "Queue clear." : "Nothing due."}</h2>
        <p className={s.stopBody}>
          {done > 0
            ? `${done} ${done === 1 ? "call" : "calls"} logged. Callbacks you booked will appear here when they come due.`
            : "No callbacks are due and every new lead has been worked. Import more, or come back when a callback lands."}
        </p>
        {initial.suppressedCount > 0 ? (
          <p className={s.stopMeta}>
            <span className={s.num}>{initial.suppressedCount}</span>{" "}
            {initial.suppressedCount === 1 ? "business is" : "businesses are"} on the
            do-not-call list and were never shown.
          </p>
        ) : null}
        {initial.needsNumberCount > 0 ? (
          // Said here so the shortfall between "59 imported" and what you
          // actually called is never something to work out mid-morning.
          <p className={s.stopMeta}>
            <span className={s.num}>{initial.needsNumberCount}</span> have no number
            yet. Finding one is research, not a call, so they are kept out of here.
          </p>
        ) : null}
      </section>
    );
  }

  const position = done + 1;
  const total = done + rows.length;

  return (
    <>
      <article className={s.card} aria-live="polite">
        <p className={s.progress}>
          <span className={s.num}>{position}</span>
          <span className={s.progressOf}> of </span>
          <span className={s.num}>{total}</span>
          {lead.rank === "callback" ? <span className={s.flag}>callback due</span> : null}
        </p>

        <h2 className={s.business}>{lead.businessName}</h2>

        {/*
          * The opener. These two faults are the reason there is a call at all,
          * so they sit directly under the name — not in a panel you would have
          * to open while the phone is already ringing.
          */}
        {lead.auditFaults.length > 0 ? (
          <ul className={s.faults}>
            {lead.auditFaults.slice(0, 2).map((fault) => (
              <li key={fault} className={s.fault}>
                {fault}
              </li>
            ))}
          </ul>
        ) : null}

        {lead.callNote ? <p className={s.note}>{lead.callNote}</p> : null}

        <dl className={s.meta}>
          {lead.ownerName ? (
            <div className={s.metaRow}>
              <dt className={s.metaKey}>Ask for</dt>
              <dd className={s.metaValue}>
                {lead.ownerName}
                {lead.ownerNameConfidence && lead.ownerNameConfidence !== "high" ? (
                  // Said out loud. Opening with the wrong person's name is
                  // worse than opening with none.
                  <span className={s.hedge}> — {lead.ownerNameConfidence} confidence</span>
                ) : null}
              </dd>
            </div>
          ) : null}
          <div className={s.metaRow}>
            <dt className={s.metaKey}>Attempts</dt>
            <dd className={s.metaValue}>
              <span className={s.num}>{lead.attempts}</span>
              {lead.lastOutcome ? <span className={s.hedge}> — last: {lead.lastOutcome}</span> : null}
            </dd>
          </div>
          {/*
            * ON SCREEN DURING THE CALL, on purpose. "Where did you get my
            * number" is asked often enough that having to leave the screen to
            * answer it is how people end up guessing.
            */}
          <div className={s.metaRow}>
            <dt className={s.metaKey}>Found via</dt>
            <dd className={s.metaValue}>{lead.source.replace(/_/g, " ")}</dd>
          </div>
        </dl>
      </article>

      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}

      {callbackFor === lead.leadId ? (
        /*
         * PRESETS, NOT A PICKER.
         *
         * The picker asked for a date and a time on a scroll wheel, one-handed,
         * while the prospect was still on the line — four taps for a thing they
         * expressed in three words. These are the words: one tap, and the panel
         * closes because choosing IS confirming. There is no Save button,
         * because a two-step commit for a single choice is the friction all
         * over again.
         *
         * No free-text time entry at all. A callback is agreed in half-days on
         * a phone call, and capturing 11:15 would record a precision the
         * conversation did not have.
         */
        <div className={s.callback}>
          <p className={s.callbackLabel}>When did they say?</p>

          <div className={s.presets}>
            {quickPresets(new Date()).map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={s.preset}
                disabled={busy || preset.at === null}
                onClick={() => preset.at !== null && saveCallback(preset.at)}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {pickingDay ? (
            <div className={s.dayGrid}>
              {dayGrid(new Date()).map((day) => (
                <div key={day.label} className={s.dayRow}>
                  <span className={s.dayLabel}>{day.label}</span>
                  <button
                    type="button"
                    className={s.dayTime}
                    disabled={busy}
                    onClick={() => saveCallback(day.morning)}
                  >
                    09:00
                  </button>
                  <button
                    type="button"
                    className={s.dayTime}
                    disabled={busy}
                    onClick={() => saveCallback(day.afternoon)}
                  >
                    14:00
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className={s.callbackActions}>
            <button
              type="button"
              className={s.secondary}
              onClick={() => {
                setCallbackFor(null);
                setPickingDay(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={s.secondary}
              onClick={() => setPickingDay((open) => !open)}
            >
              {pickingDay ? "Fewer options" : "Another day"}
            </button>
          </div>
        </div>
      ) : null}

      {/*
        * THE THUMB ZONE. Fixed to the bottom, above the safe-area inset, so
        * it is reachable one-handed on a phone held normally.
        */}
      <div className={s.actions}>
        {/*
          * Always present. The queue excludes leads with no dialable number
          * rather than rendering a dead button, so there is no branch here —
          * a dial that does nothing is how a screen stops being trusted.
          *
          * `href` takes the E.164 key because that is what dials reliably;
          * the label shows what the source said, because that is what a
          * person recognises and it carries any second number.
          */}
        <a className={s.dial} href={`tel:${lead.phone}`}>
          Call <span className={s.dialNumber}>{lead.phoneDisplay}</span>
        </a>

        {/*
          * BUILD A DEMO, mid-call. The moment it is wanted is "can you show
          * me?", and the answer has to be a link in the next thirty seconds.
          *
          * The path is shown rather than opened: the useful action is pasting
          * it into WhatsApp, and opening it would leave the queue.
          */}
        {demoPath ? (
          <button
            type="button"
            className={s.demoLink}
            onClick={() => {
              const url = `${window.location.origin.replace("//app.", "//")}${demoPath}`;
              void navigator.clipboard?.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied — paste it to them" : `Copy link ${demoPath}`}
          </button>
        ) : (
          <button
            type="button"
            className={s.outcome}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const built = await buildDemo({ leadId: lead.leadId });
                setDemoPath(built.path);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not build that demo.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Build a demo site
          </button>
        )}

        <div className={s.outcomes}>
          <button type="button" className={s.outcome} disabled={busy} onClick={() => disposition("no_answer")}>
            No answer
          </button>
          <button type="button" className={s.outcome} disabled={busy} onClick={() => disposition("voicemail")}>
            Voicemail
          </button>
          <button
            type="button"
            className={s.outcome}
            disabled={busy}
            onClick={() => setCallbackFor(lead.leadId)}
          >
            Callback
          </button>
          <button
            type="button"
            className={s.outcomeGood}
            disabled={busy}
            onClick={() => disposition("meeting_set")}
          >
            Meeting set
          </button>
        </div>

        {/*
          * SEPARATED, and not by decoration. These two write a suppression:
          * the business stops appearing, permanently, from the next queue on.
          * Mis-tapping one next to "No answer" would quietly delete a lead,
          * so they sit apart, in a row of their own, and read as what they do.
          */}
        <div className={s.finals}>
          <button
            type="button"
            className={s.final}
            disabled={busy}
            onClick={() => disposition("not_interested")}
          >
            Not interested — do not call again
          </button>
          <button
            type="button"
            className={s.final}
            disabled={busy}
            onClick={() => disposition("wrong_number")}
          >
            Wrong number
          </button>
        </div>
      </div>
    </>
  );
}
