"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@cc/convex/api";
import type { Id } from "@cc/convex/dataModel";
import { duplicateNames, parseLeads } from "@/lib/parse-leads";
import s from "./import.module.css";

/**
 * BRINGING A LIST IN, WITH THE PROVENANCE THAT MAKES IT DEFENSIBLE.
 *
 * The queue, the suppression list and the demo builder all work. Production
 * has no leads in it, and the only way in was an `internalMutation` run from
 * a terminal with a hand-written JSON payload — which is a documented command,
 * and this repo has learned twice what those cost.
 *
 * IT PREVIEWS BEFORE IT WRITES, and that is not politeness. `provenance` is
 * required at capture and a guard forbids ever patching it: a batch imported
 * with the wrong `capturedAt` or the wrong directory named is wrong for as
 * long as those rows exist, and "where did you get my number" is answered
 * from the row rather than from anybody's memory. The preview is the last
 * moment the answer can still be changed.
 */

type Venture = { _id: string; name: string };

const SOURCES = [
  { value: "campaign_list", label: "A directory or campaign list" },
  { value: "sa_venues", label: "SA venues list" },
  { value: "referral", label: "Referral" },
  { value: "inbound", label: "They contacted us" },
  { value: "places", label: "Google Places" },
] as const;

export function ImportLeads({ ventures }: { ventures: Venture[] }) {
  const importLeads = useMutation(api.leadImport.importFromConsole);

  const [ventureId, setVentureId] = useState(ventures[0]?._id ?? "");
  const [niche, setNiche] = useState("");
  const [source, setSource] = useState<(typeof SOURCES)[number]["value"]>("campaign_list");
  const [lawfulBasis, setLawfulBasis] =
    useState<"legitimate_interest" | "consent">("legitimate_interest");
  const [capturedAt, setCapturedAt] = useState("");
  const [defaultDetail, setDefaultDetail] = useState("");
  const [pasted, setPasted] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
    withoutPhone: number;
    unusable: string[];
  } | null>(null);

  const parsed = useMemo(() => parseLeads(pasted), [pasted]);
  const dupes = useMemo(() => duplicateNames(parsed.rows), [parsed.rows]);
  const missingDetail = parsed.rows.filter((r) => !r.detail).length;

  /*
   * A capture date in the FUTURE is refused by the backend, and saying so
   * here turns a rejected import into a corrected field. `capturedAt` is when
   * the list was originally pulled, not when this runs.
   */
  const futureCapture = capturedAt !== "" && Date.parse(`${capturedAt}T12:00:00Z`) > Date.now();

  const ready =
    parsed.rows.length > 0 &&
    !parsed.error &&
    niche.trim() !== "" &&
    capturedAt !== "" &&
    !futureCapture &&
    (defaultDetail.trim() !== "" || missingDetail === 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const outcome = await importLeads({
        ventureId: ventureId as Id<"ventures">,
        niche: niche.trim(),
        source,
        lawfulBasis,
        // Midday UTC, so a date typed in Durban does not land on the previous
        // day and read as an earlier capture than it was.
        capturedAt: Date.parse(`${capturedAt}T12:00:00Z`),
        rows: parsed.rows.map((row) => ({
          businessName: row.businessName,
          phone: row.phone,
          website: row.website,
          area: row.area,
          ownerName: row.ownerName,
          /*
           * Per row, falling back to the batch answer. "From a campaign list"
           * is not an answer to "where did you get my number"; "you are
           * listed on SolarZA" is — so the specific listing wins where the
           * file carries one.
           */
          detail: row.detail?.trim() || defaultDetail.trim(),
        })),
      });
      setResult(outcome);
    } catch (caught) {
      const message =
        caught && typeof caught === "object" && "data" in caught
          ? (caught.data as { message?: string })?.message
          : undefined;
      setError(message ?? "That did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <section className={s.done}>
        <h2 className={s.doneHeading}>
          {result.created} {result.created === 1 ? "lead" : "leads"} imported
        </h2>

        <dl className={s.facts}>
          <dt>Already here, left untouched</dt>
          <dd>{result.skipped}</dd>
          <dt>No number yet</dt>
          <dd>{result.withoutPhone}</dd>
        </dl>

        {/*
          COUNTED APART FROM THE BLANKS, deliberately. A blank number is a row
          nobody has researched; a number that would not parse is a row with a
          TYPO, and those are worth fixing rather than researching again.
          Merged into one figure the typos hide inside the blanks forever.
        */}
        {result.unusable.length > 0 ? (
          <div>
            <p className={s.warn}>
              {result.unusable.length}{" "}
              {result.unusable.length === 1 ? "number was" : "numbers were"} present and
              unreadable. These are typos rather than gaps — fix them in the source and
              import again, which will skip everything already here.
            </p>
            <ul className={s.unusable}>
              {result.unusable.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className={s.hint}>
          They are in the queue now, filtered against the suppression list.
        </p>
      </section>
    );
  }

  return (
    <form className={s.form} onSubmit={submit}>
      <section className={s.group}>
        <h2 className={s.groupTitle}>Where this list came from</h2>
        <p className={s.groupNote}>
          Recorded on every row and never editable afterwards — a guard forbids
          patching provenance, because one written later is a guess about the
          past dressed as a record of it. This is the last moment to get it right.
        </p>

        <div className={s.grid}>
          <label className={s.field}>
            <span className={s.label}>Venture</span>
            <select className={s.control} value={ventureId} onChange={(e) => setVentureId(e.target.value)}>
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

          <label className={s.field}>
            <span className={s.label}>Source</span>
            <select
              className={s.control}
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
            >
              {SOURCES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className={s.field}>
            <span className={s.label}>Lawful basis</span>
            <select
              className={s.control}
              value={lawfulBasis}
              onChange={(e) => setLawfulBasis(e.target.value as typeof lawfulBasis)}
            >
              <option value="legitimate_interest">Legitimate interest</option>
              <option value="consent">Consent</option>
            </select>
            <p className={s.fieldNote}>
              Your claim, stored and auditable. Nothing here validates it, and
              recording one is not a finding that any channel is permitted —
              POPIA s69 treats electronic marketing more strictly than a call
              to a listed business number.
            </p>
          </label>

          <label className={s.field}>
            <span className={s.label}>Pulled on</span>
            <input
              className={s.control}
              type="date"
              value={capturedAt}
              onChange={(e) => setCapturedAt(e.target.value)}
              aria-invalid={futureCapture}
            />
            <p className={futureCapture ? s.error : s.fieldNote}>
              {futureCapture
                ? "That is in the future. This is when the list was originally pulled, not when you are importing it."
                : "When the list was ORIGINALLY pulled, not today."}
            </p>
          </label>

          <label className={`${s.field} ${s.wide}`}>
            <span className={s.label}>Where, specifically</span>
            <input
              className={s.control}
              value={defaultDetail}
              placeholder="Listed on SolarZA, KZN installers page"
              onChange={(e) => setDefaultDetail(e.target.value)}
            />
            <p className={s.fieldNote}>
              Used for any row without its own detail column. &ldquo;From a campaign
              list&rdquo; is not an answer to &ldquo;where did you get my number&rdquo;;
              naming the directory is.
            </p>
          </label>
        </div>
      </section>

      <section className={s.group}>
        <h2 className={s.groupTitle}>The list</h2>
        <p className={s.groupNote}>
          Paste from a spreadsheet or a CSV. The first line must be a header —
          name, phone, website, area, detail, owner. Tabs or commas, whichever
          you paste.
        </p>
        <textarea
          className={s.paste}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={"name,phone,area\nRenu Solar,031 555 1234,Hillcrest"}
        />
      </section>

      {pasted.trim() !== "" ? (
        <section className={s.group}>
          <h2 className={s.groupTitle}>What will be imported</h2>

          {parsed.error ? (
            <p className={s.error}>{parsed.error}</p>
          ) : (
            <>
              <p className={s.count}>
                {parsed.rows.length} {parsed.rows.length === 1 ? "row" : "rows"}
              </p>

              {parsed.ignoredColumns.length > 0 ? (
                <p className={s.warn}>
                  Ignored columns: {parsed.ignoredColumns.join(", ")}. Nothing from
                  those is stored.
                </p>
              ) : null}

              {parsed.blankLines.length > 0 ? (
                <p className={s.warn}>
                  {parsed.blankLines.length} line(s) had no business name and will be
                  skipped — lines {parsed.blankLines.join(", ")}.
                </p>
              ) : null}

              {dupes.length > 0 ? (
                <p className={s.warn}>
                  Repeated in this paste: {dupes.join(", ")}. Only the first of each
                  is imported.
                </p>
              ) : null}

              {missingDetail > 0 && defaultDetail.trim() === "" ? (
                <p className={s.error}>
                  {missingDetail} row(s) have no detail column, so they need the
                  &ldquo;where, specifically&rdquo; answer above before this can run.
                </p>
              ) : null}

              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th>Business</th>
                      <th>Phone</th>
                      <th>Area</th>
                      <th>Where from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 12).map((row, i) => (
                      <tr key={`${row.businessName}-${i}`}>
                        <td>{row.businessName}</td>
                        <td className={s.mono}>{row.phone ?? "—"}</td>
                        <td>{row.area ?? "—"}</td>
                        <td>{row.detail ?? (defaultDetail || "—")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsed.rows.length > 12 ? (
                <p className={s.hint}>
                  Showing the first 12 of {parsed.rows.length}.
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <div className={s.actions}>
        <button className={s.primary} type="submit" disabled={busy || !ready}>
          {busy ? "Importing…" : `Import ${parsed.rows.length || ""} ${parsed.rows.length === 1 ? "lead" : "leads"}`.trim()}
        </button>
        {error ? <p className={s.error}>{error}</p> : null}
      </div>
    </form>
  );
}
