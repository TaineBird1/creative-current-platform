import { notFound } from "next/navigation";
import { AddBackOffice } from "../../admin/clients/new/AddBackOffice";
import s from "../../admin/clients/new/new-client.module.css";

/**
 * THE ADD-A-BACK-OFFICE SCREEN, WITH FIXTURES.
 *
 * `/admin/clients/new` is behind a session — a request without one is
 * redirected, which is correct and also means nobody can look at the screen.
 * That is exactly how three rendering bugs reached a merged invoice document
 * that no test could see and no person had opened.
 *
 * It renders `AddBackOffice` — the SAME component `/admin/clients/new`
 * renders, not a copy. The repeating field editor is the part worth looking
 * at: it grows a row at a time and has to stay usable on a phone, and neither
 * of those is checkable from source.
 *
 * THE BUTTONS ARE LIVE AND REACH NOTHING. `onboarding.addBackOffice` is an
 * `ownerMutation` that re-derives the caller from their own identity, so an
 * unauthenticated visitor is refused and the fixture venture id matches no
 * row. Said out loud because the FIXTURES-ONLY guard scans this file for
 * Convex imports and finds none — the mutation arrives through the component.
 *
 * SAME THREE BARRIERS as every other preview, every default off: the file is
 * `page.preview.tsx` so Next does not route it; `ALLOW_PREVIEW_ROUTES` is
 * absent from turbo.json so a Vercel build cannot see the flag; and it
 * refuses below regardless. `scripts/assert-no-preview-route.mjs` reads the
 * built manifest in CI rather than trusting any of the three.
 *
 *   pnpm dev:preview
 *   http://localhost:3200/preview/add-client
 */
export const dynamic = "force-dynamic";

/** Obviously fake, and matching no row on any deployment. */
const VENTURES = [
  { _id: "jd7fake0venture0000000000001", name: "Sites" },
  { _id: "jd7fake0venture0000000000002", name: "Systems" },
];

export default function AddClientPreview() {
  // Barrier 3. Absent means no, like every other default here.
  if (process.env.ALLOW_PREVIEW_ROUTES !== "1") notFound();

  return (
    <div className="world-admin">
      <main className={s.page}>
        <header className={s.pageHead}>
          <h1 className={s.pageHeading}>Add a back office</h1>
          <p className={s.hint}>
            For a client who came direct and whose website is hosted
            elsewhere. Creates the client, an enquiry form the server
            validates against, and an invite — in one transaction. No deal is
            touched and no invoice is issued.
          </p>
        </header>

        <AddBackOffice ventures={VENTURES} />
      </main>
    </div>
  );
}
