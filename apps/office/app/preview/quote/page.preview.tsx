import { notFound } from "next/navigation";
import { QuoteDocument, QuoteRefusal, type QuoteView } from "../../q/[token]/QuoteDocument";

/**
 * THE QUOTE A CUSTOMER SEES, WITH NO BACKEND.
 *
 * This document is what decides whether a five-figure job happens, and until a
 * client exists and sends a real quote there is no way to look at it. The same
 * gap the invoice had, closed the same way.
 *
 * It renders `QuoteDocument` — the SAME component `/q/<token>` renders, not a
 * copy of its markup. That is why the document was split out of the page.
 *
 * FIXTURES ARE OBVIOUSLY FAKE. Example Solar, round numbers no real survey
 * would produce. If a screenshot escapes it must not be mistaken for a real
 * customer's quote.
 *
 * SAME THREE BARRIERS as every other preview, every default off: the file is
 * `page.preview.tsx` so Next does not route it; `ALLOW_PREVIEW_ROUTES` is
 * absent from turbo.json so a Vercel build cannot see the flag; and it refuses
 * below regardless. `scripts/assert-no-preview-route.mjs` checks the built
 * manifest in CI rather than trusting any of that.
 *
 *   pnpm dev:preview
 *   http://localhost:3200/preview/quote?state=live
 */
export const dynamic = "force-dynamic";

const DAY = 24 * 60 * 60 * 1000;

const LINES: QuoteView["lineItems"] = [
  {
    description: "8kW hybrid inverter, supplied and fitted",
    quantity: 1,
    unitPriceCents: 4_800_000,
    lineTotalCents: 4_800_000,
  },
  {
    description: "455W panels, mounted and wired",
    quantity: 12,
    unitPriceCents: 320_000,
    lineTotalCents: 3_840_000,
  },
  {
    description: "5.1kWh battery",
    quantity: 2,
    unitPriceCents: 2_100_000,
    lineTotalCents: 4_200_000,
  },
  {
    description: "Roof mounting, cabling, CoC and commissioning",
    quantity: 1,
    unitPriceCents: 1_160_000,
    lineTotalCents: 1_160_000,
  },
];

const TOTAL = 14_000_000;

function base(): QuoteView {
  return {
    number: "QUO-0001",
    businessName: "Example Solar",
    lineItems: LINES,
    subtotalCents: TOTAL,
    totalCents: TOTAL,
    currency: "ZAR",
    expiresAt: Date.now() + 11 * DAY,
    expired: false,
    accepted: false,
    acceptedAt: null,
    acceptable: true,
  };
}

/**
 * Every state the document has. The ones that go wrong are the ones written
 * for the live case only — an expired quote that still shows an accept button
 * is a customer agreeing to a price the business will not honour.
 */
const STATES: Record<string, () => QuoteView> = {
  live: base,

  expired: () => ({
    ...base(),
    expiresAt: Date.now() - 3 * DAY,
    expired: true,
    acceptable: false,
  }),

  accepted: () => ({
    ...base(),
    accepted: true,
    acceptedAt: Date.now() - DAY,
    acceptable: false,
  }),

  /* One line, so the table is not the page. */
  single: () => ({
    ...base(),
    lineItems: [LINES[0]!],
    subtotalCents: 4_800_000,
    totalCents: 4_800_000,
  }),

  /* No business name — the join can return null, and the page must still read. */
  nameless: () => ({ ...base(), businessName: null }),
};

export default function QuotePreview({
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
  const want = typeof params.state === "string" ? params.state : "live";

  if (want === "refused") {
    return <QuoteRefusal reason="that link is not valid" />;
  }
  if (want === "withdrawn") {
    return <QuoteRefusal reason="that quote was withdrawn" />;
  }

  const build = STATES[want] ?? STATES.live!;
  /*
   * A token that is visibly not a token. The accept button is live in this
   * harness and will call the real mutation; it must fail on a link that
   * cannot exist rather than reach anything.
   */
  return <QuoteDocument quote={build()} token="preview-not-a-real-token" />;
}
