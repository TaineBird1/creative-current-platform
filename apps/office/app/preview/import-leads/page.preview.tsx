import { notFound } from "next/navigation";
import { ImportLeads } from "../../admin/leads/import/ImportLeads";
import { SourcePlaces } from "../../admin/leads/import/SourcePlaces";
import s from "../../admin/leads/import/import.module.css";

/**
 * THE LEAD IMPORT SCREEN, WITH FIXTURES.
 *
 * `/admin/leads/import` is behind a session, so a request without one is
 * redirected -- correct, and it also means nobody can look at the screen.
 * That is how three rendering bugs reached a merged invoice document that no
 * test could see and no person had opened.
 *
 * It renders `ImportLeads` -- the SAME component `/admin/leads/import`
 * renders, not a copy. The part worth looking at is the PREVIEW: paste
 * something and the parsed table, the ignored columns and the duplicate
 * warnings all appear, and none of that is checkable from source.
 *
 * The button is live and reaches nothing: `importFromConsole` is an
 * `ownerMutation` that re-derives the caller from their own identity, so an
 * unauthenticated visitor is refused and the fixture venture id matches no
 * row.
 *
 * SAME THREE BARRIERS as every other preview, every default off.
 *
 *   pnpm dev:preview
 *   http://localhost:3200/preview/import-leads
 */
export const dynamic = "force-dynamic";

const VENTURES = [
  { _id: "jd7fake0venture0000000000001", name: "Sites" },
  { _id: "jd7fake0venture0000000000002", name: "Systems" },
];

export default function ImportLeadsPreview() {
  // Barrier 3. Absent means no, like every other default here.
  if (process.env.ALLOW_PREVIEW_ROUTES !== "1") notFound();

  return (
    <div className="world-admin">
      <main className={s.page}>
        <header className={s.pageHead}>
          <h1 className={s.pageHeading}>Import leads</h1>
          <p className={s.hint}>
            Paste a list from a directory. Every row carries where it came
            from, recorded at capture and never editable afterwards.
          </p>
        </header>

        <ImportLeads ventures={VENTURES} />
        {/* A configured cap, so the ordinary state is what gets reviewed.
            `?nocap=1` shows the refusal instead. */}
        <SourcePlaces
          ventures={VENTURES}
          spend={{
            period: "2026-09",
            capCents: 2000,
            spentCents: 360,
            remainingCents: 1640,
            unitCostCents: { textSearch: 60 },
            willRefuse: false,
          }}
        />
      </main>
    </div>
  );
}
