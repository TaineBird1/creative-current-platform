"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@cc/convex/api";
import type { Id } from "@cc/convex/dataModel";
import s from "./import.module.css";

/**
 * SOURCING FROM GOOGLE PLACES — the half that spends money.
 *
 * It sits beside the paste box rather than on its own screen because they
 * answer the same question. One types the list in, the other buys it.
 *
 * PAGES, NOT RESULTS, on the control as well as in the API. A page is what
 * gets billed, so a screen offering "how many businesses" would hide the
 * thing being bought behind the thing being wanted. Twenty per page, and the
 * cost of each is whatever the month's cap prices `textSearch` at.
 *
 * IT DOES NOT PREVIEW, and that is not an inconsistency with the paste box.
 * A preview there is free — the rows are already in the browser. Here the
 * results do not exist until they are bought, so "preview" would mean
 * "spend, then ask" and the asking would be theatre. What this screen owes
 * the reader instead is a clear statement of what a run will cost BEFORE it
 * starts, and the ledger's own refusal when the cap is reached.
 */

type Venture = { _id: string; name: string };

export function SourcePlaces({ ventures }: { ventures: Venture[] }) {
  const run = useAction(api.sourcing.run);

  const [ventureId, setVentureId] = useState(ventures[0]?._id ?? "");
  const [niche, setNiche] = useState("");
  const [textQuery, setTextQuery] = useState("");
  const [maxPages, setMaxPages] = useState(1);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
    withoutPhone: number;
    unusable: string[];
    pagesFetched: number;
    found: number;
    stoppedBecause: string;
    spentCents: number;
  } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await run({
          ventureId: ventureId as Id<"ventures">,
          niche: niche.trim(),
          textQuery: textQuery.trim(),
          maxPages,
          /*
           * A listed business number, sourced from a public directory, called
           * about their own trade. Recorded as the operator's claim — nothing
           * here validates it, and POPIA s69 treats electronic marketing more
           * strictly than a call.
           */
          lawfulBasis: "legitimate_interest",
        }),
      );
    } catch (caught) {
      const message =
        caught && typeof caught === "object" && "data" in caught
          ? (caught.data as { message?: string })?.message
          : undefined;
      setError(message ?? "That did not run. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={s.form} onSubmit={submit}>
      <section className={s.group}>
        <h2 className={s.groupTitle}>Or search Google Places</h2>
        <p className={s.groupNote}>
          This spends money. Each page is one billed search and returns up to
          twenty businesses; the month&rsquo;s cap refuses the call that would
          cross it, and a deployment with no cap set runs nothing at all.
        </p>

        <div className={s.grid}>
          <label className={s.field}>
            <span className={s.label}>Venture</span>
            <select
              className={s.control}
              value={ventureId}
              onChange={(e) => setVentureId(e.target.value)}
            >
              {ventures.map((v) => (
                <option key={v._id} value={v._id}>{v.name}</option>
              ))}
            </select>
          </label>

          <label className={s.field}>
            <span className={s.label}>Niche</span>
            <input
              className={s.control}
              value={niche}
              placeholder="solar-trades"
              onChange={(e) => setNiche(e.target.value)}
            />
          </label>

          <label className={`${s.field} ${s.wide}`}>
            <span className={s.label}>Search</span>
            <input
              className={s.control}
              value={textQuery}
              placeholder="solar installers in Ballito"
              onChange={(e) => setTextQuery(e.target.value)}
            />
            <p className={s.fieldNote}>
              In Google&rsquo;s words, as you would type it into Maps.
            </p>
          </label>

          <label className={s.field}>
            <span className={s.label}>Pages</span>
            <input
              className={`${s.control} ${s.mono}`}
              type="number"
              min={1}
              max={10}
              value={maxPages}
              onChange={(e) => setMaxPages(Number(e.target.value))}
            />
            <p className={s.fieldNote}>
              One billed search each, up to twenty businesses a page.
            </p>
          </label>
        </div>
      </section>

      <div className={s.actions}>
        <button
          className={s.primary}
          type="submit"
          disabled={busy || textQuery.trim() === "" || niche.trim() === ""}
        >
          {busy ? "Searching…" : `Search and import (${maxPages} paid ${maxPages === 1 ? "search" : "searches"})`}
        </button>
        {error ? <p className={s.error}>{error}</p> : null}
      </div>

      {result ? (
        <section className={s.done}>
          <h2 className={s.doneHeading}>
            {result.created} new {result.created === 1 ? "lead" : "leads"}
          </h2>

          <dl className={s.facts}>
            <dt>Found</dt>
            <dd>{result.found}</dd>
            <dt>Already here, left untouched</dt>
            <dd>{result.skipped}</dd>
            <dt>No number yet</dt>
            <dd>{result.withoutPhone}</dd>
            <dt>Billed searches</dt>
            <dd>{result.pagesFetched}</dd>
            <dt>Spent this month</dt>
            <dd className={s.mono}>R {(result.spentCents / 100).toFixed(2)}</dd>
          </dl>

          {/*
            THE RUN SAYS WHY IT STOPPED. "Fewer than you asked for" and "the
            cap refused the next one" look identical in a count, and only one
            of them is a reason to go and raise something.
          */}
          {result.stoppedBecause === "spend cap" ? (
            <p className={s.warn}>
              Stopped at the spend cap. What had already been paid for was
              imported. Raise the month&rsquo;s cap deliberately, or wait for
              the next one.
            </p>
          ) : null}
          {result.stoppedBecause === "page limit" ? (
            <p className={s.hint}>
              Stopped at the page limit you set — there were more results.
            </p>
          ) : null}

          {result.unusable.length > 0 ? (
            <ul className={s.unusable}>
              {result.unusable.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </form>
  );
}
