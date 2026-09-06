import { notFound } from "next/navigation";
import { IssuerForm, type IssuerRow } from "../../admin/issuer/IssuerForm";
import s from "../../admin/issuer/issuer.module.css";

/**
 * THE ISSUER SCREEN, WITH FIXTURES.
 *
 * It renders `IssuerForm` — the SAME component `/admin/issuer` renders, not a
 * copy. The states worth looking at only appear conditionally and none of
 * them is checkable from source: the confirmation panel exists only for a
 * stored-but-unconfirmed row, the "saving clears the confirmation" warning
 * only once a confirmed row has been edited, and the partial-bank warning
 * only between one and three of four fields.
 *
 * FIXTURES ARE OBVIOUSLY FAKE — and here that is load-bearing rather than
 * hygiene. This screen's entire purpose is to stop a plausible invented legal
 * name printing on a document a client keeps, so its own harness must not
 * contain one that could be mistaken for real. Every value trips the server's
 * own `PLACEHOLDER` list on a whole-word match, which means these fixtures
 * would be REFUSED by `issuer.set` if anybody ever pointed this at a real
 * deployment.
 *
 * The buttons are live and reach nothing: every mutation here is an
 * `ownerMutation` that re-derives the caller from their own identity, so an
 * unauthenticated visitor is refused and the fixture venture id matches no
 * row.
 *
 * SAME THREE BARRIERS as every other preview, every default off: the file is
 * `page.preview.tsx` so Next does not route it; `ALLOW_PREVIEW_ROUTES` is
 * absent from turbo.json so a Vercel build cannot see the flag; and it
 * refuses below regardless. `scripts/assert-no-preview-route.mjs` reads the
 * built manifest in CI rather than trusting any of the three.
 *
 *   pnpm dev:preview
 *   http://localhost:3200/preview/issuer
 */
export const dynamic = "force-dynamic";

const VENTURE = "jd7fake0venturefixture000000" as never;

/** Stored and confirmed — the state a working deployment sits in. */
const CONFIRMED: IssuerRow = {
  legalName: "Example Placeholder",
  tradingName: "Example Trading",
  addressLine: "1 Example Road",
  suburb: "Sample Suburb",
  city: "Testville",
  postalCode: "0000",
  email: "accounts@example.com",
  phone: "+27 00 000 0000",
  bankName: "Example Bank",
  bankAccountName: "Example Placeholder",
  bankAccountNumber: "0000000000",
  bankBranchCode: "000000",
  confirmed: true,
  confirmedAt: Date.parse("2026-09-01T09:00:00+02:00"),
};

/** Stored, NOT confirmed — the only state that shows the confirm panel. */
const UNCONFIRMED: IssuerRow = {
  ...CONFIRMED,
  confirmed: true,
  confirmedAt: undefined,
} as IssuerRow;

/** Three of four bank fields — a document with nowhere to pay. */
const PARTIAL_BANK: IssuerRow = {
  ...CONFIRMED,
  bankBranchCode: undefined,
  confirmed: false,
  confirmedAt: undefined,
} as IssuerRow;

export default function IssuerPreview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Barrier 3. Absent means no, like every other default here.
  if (process.env.ALLOW_PREVIEW_ROUTES !== "1") notFound();
  return <Preview searchParams={searchParams} />;
}

async function Preview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const which = typeof params.state === "string" ? params.state : "confirmed";

  const issuer: IssuerRow =
    which === "empty"
      ? null
      : which === "unconfirmed"
        ? { ...(UNCONFIRMED as NonNullable<IssuerRow>), confirmed: false }
        : which === "partial"
          ? PARTIAL_BANK
          : CONFIRMED;

  const state = !issuer ? "blocked" : issuer.confirmed ? "ready" : "pending";

  return (
    <div className="world-admin">
      <main className={s.page}>
        <header className={s.pageHead}>
          <h1 className={s.pageHeading}>Who issues the invoices</h1>
          <p className={s.hint}>
            The legal name, address and bank details that print on every
            invoice and quote you send. Set once per venture.
          </p>
        </header>

        <section className={s.state} data-tone={state}>
          <h2 className={s.stateHeading}>
            {state === "ready"
              ? "Confirmed — invoices can be issued"
              : state === "pending"
                ? "Set, but not confirmed"
                : "Nothing can be invoiced yet"}
          </h2>
          <p className={s.stateBody}>
            Fixture state: <code>{which}</code>. Try{" "}
            <code>?state=empty</code>, <code>?state=unconfirmed</code>,{" "}
            <code>?state=partial</code>.
          </p>
        </section>

        <IssuerForm ventureId={VENTURE} issuer={issuer} />
      </main>
    </div>
  );
}
