import { notFound } from "next/navigation";
import type { InvoiceView } from "@cc/convex-src/public/invoice";
import { InvoiceDocument, InvoiceRefusal } from "../../i/[token]/InvoiceDocument";

/**
 * THE INVOICE, WITH NO BACKEND.
 *
 * This document has never been seen by a human, and that is the gap it fills.
 * It is the client-facing half of invoicing — the thing a client's BOOKKEEPER
 * opens — and until a real client exists and a real invoice is issued, the
 * only way to look at it is to mint a token by hand against a live deployment.
 * A document nobody has read is a document nobody has proof-read.
 *
 * It renders `InvoiceDocument` — the SAME file `/i/<token>` renders, not a
 * copy of its markup. A harness that duplicates the markup stops telling the
 * truth the first time somebody edits one of the two, silently, which is worse
 * than having no harness at all. That is why the document was split out of the
 * page: so this could import it without importing a way to fetch.
 *
 * THE FIXTURES ARE OBVIOUSLY FAKE, ON PURPOSE. Addresses are @example.com
 * (RFC 2606 — cannot be registered, never resolves), the bank account is
 * visibly a placeholder, and the amounts are round numbers no quote would
 * ever produce. If a screenshot of this ever escapes, it must not be mistaken
 * for a real client's invoice, and nobody must ever pay into the account
 * printed on it.
 *
 * SAME THREE BARRIERS AS THE BOOKINGS HARNESS, every default off:
 *
 *  1. THE FILE IS NOT A PAGE. `page.preview.tsx` is not routed by Next unless
 *     `preview.tsx` is in pageExtensions. Without the flag the route is not in
 *     the manifest and not in the bundle.
 *  2. THE BUILD CANNOT SEE THE FLAG. `ALLOW_PREVIEW_ROUTES` is absent from
 *     turbo.json, and Turborepo filters the environment to what a task
 *     declares — so setting it in Vercel does nothing.
 *  3. AND IT STILL REFUSES, below, before anything renders.
 *
 * Barrier 1 is now asserted against a real production BUILD, not only against
 * the source: `scripts/assert-no-preview-route.mjs` reads the route manifest
 * in CI. This file's own claim to be un-shippable is therefore checked rather
 * than believed.
 *
 * Run it with:
 *   ALLOW_PREVIEW_ROUTES=1 pnpm --filter @cc/office dev
 *   http://localhost:3200/preview/invoice?state=unpaid
 */
export const dynamic = "force-dynamic";

const DAY = 24 * 60 * 60 * 1000;
const now = () => Date.now();

/**
 * The issuer block. A sole proprietor invoicing in their own name, which is
 * the real shape today — no registration number, no VAT number, so neither
 * line renders and that absence is itself worth seeing.
 */
const ISSUER: InvoiceView["issuer"] = {
  tradingName: "The Creative Current",
  addressLine: "14 Example Road",
  suburb: "Hillcrest",
  city: "Durban",
  postalCode: "3610",
  countryCode: "ZA",
  email: "accounts@example.com",
  phone: "+27 31 000 0000",
  bank: {
    name: "Example Bank",
    accountName: "A Example",
    // Visibly a placeholder. Nobody must ever pay into a number on a fixture.
    accountNumber: "0000 0000 0000",
    branchCode: "000000",
  },
};

/** Round numbers no real quote would produce. R12 000 + R1 500. */
const LINES: InvoiceView["lineItems"] = [
  {
    description: "Website build — solar/trades template",
    quantity: 1,
    unitPriceCents: 1_200_000,
    lineTotalCents: 1_200_000,
    kind: "charge",
  },
  {
    description: "Care plan — first month",
    quantity: 1,
    unitPriceCents: 150_000,
    lineTotalCents: 150_000,
    kind: "charge",
  },
];

const TOTAL = 1_350_000;

function base(): InvoiceView {
  return {
    number: "INV-0001",
    issuedAt: now() - 3 * DAY,
    dueAt: now() + 4 * DAY,
    paymentTermsDays: 7,
    status: "issued",
    issuerLegalName: "A Example",
    issuerRegistrationNumber: null,
    issuerVatNumber: null,
    billToName: "Example Solar (Pty) Ltd",
    issuer: ISSUER,
    currency: "ZAR",
    lineItems: LINES,
    subtotalCents: TOTAL,
    taxCents: 0,
    totalCents: TOTAL,
    taxFlag: false,
    paymentReference: "INV-0001",
    settlement: "unpaid",
    paidCents: 0,
    owedCents: TOTAL,
    creditCents: 0,
    overdue: false,
  };
}

/**
 * EVERY STATE THE DOCUMENT HAS, because the ones that go wrong are the ones
 * written for the ordinary case only. A void invoice that reads as payable and
 * an overpaid one that reads as owing both end with a client paying the wrong
 * amount, and neither is visible from the unpaid case.
 */
const STATES: Record<string, () => InvoiceView> = {
  unpaid: base,

  overdue: () => ({
    ...base(),
    issuedAt: now() - 21 * DAY,
    dueAt: now() - 14 * DAY,
    overdue: true,
  }),

  part_paid: () => ({
    ...base(),
    settlement: "part_paid",
    paidCents: 500_000,
    owedCents: TOTAL - 500_000,
  }),

  settled: () => ({
    ...base(),
    settlement: "settled",
    paidCents: TOTAL,
    owedCents: 0,
  }),

  overpaid: () => ({
    ...base(),
    settlement: "overpaid",
    paidCents: TOTAL + 25_000,
    owedCents: 0,
    creditCents: 25_000,
  }),

  void: () => ({
    ...base(),
    status: "void",
    settlement: "void",
    owedCents: 0,
  }),

  /*
   * No bank block. All four fields or none — this is what a reader sees when
   * the issuer has not filled them in, and it must not be a blank space where
   * an account number should be.
   */
  no_bank: () => ({ ...base(), issuer: { ...ISSUER, bank: null } }),

  /*
   * VAT registered. Off today and the whole point of seeing it is that the
   * subtotal row only appears when something sits beside it.
   */
  vat: () => ({
    ...base(),
    issuerRegistrationNumber: "2026/000000/07",
    issuerVatNumber: "4000000000",
    issuerLegalName: "Example Holdings (Pty) Ltd",
    taxFlag: true,
    taxCents: 202_500,
    totalCents: TOTAL + 202_500,
    owedCents: TOTAL + 202_500,
  }),

  /*
   * A long line list and long names, because a document that only looks right
   * with two short lines is one that breaks on the first real invoice.
   */
  long: () => {
    const lines: InvoiceView["lineItems"] = [
      ...LINES,
      {
        description:
          "Additional service-area landing pages — Hillcrest, Kloof, Waterfall, Gillitts, Assagay",
        quantity: 5,
        unitPriceCents: 60_000,
        lineTotalCents: 300_000,
        kind: "charge",
      },
      {
        description: "Photography — half day on site",
        quantity: 1,
        unitPriceCents: 250_000,
        lineTotalCents: 250_000,
        kind: "charge",
      },
      {
        description: "Referral credit",
        quantity: 1,
        unitPriceCents: -100_000,
        lineTotalCents: -100_000,
        kind: "credit",
      },
    ];
    const total = 1_800_000;
    return {
      ...base(),
      billToName: "Example Renewable Energy Solutions KwaZulu-Natal (Pty) Ltd",
      lineItems: lines,
      subtotalCents: total,
      totalCents: total,
      owedCents: total,
    };
  },
};

export default function InvoicePreview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Barrier 3. Absent means no — the same direction as every other default
  // here, and the only one that is safe when somebody is wrong.
  if (process.env.ALLOW_PREVIEW_ROUTES !== "1") notFound();
  return <Preview searchParams={searchParams} />;
}

async function Preview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const want = typeof params.state === "string" ? params.state : "unpaid";

  /*
   * The refusal is a state of this route too, and the one a bookkeeper is
   * most likely to hit — a link truncated by a chat client, or one that was
   * withdrawn. It has to read as "ask for another", never as an error page.
   */
  if (want === "refused") {
    return <InvoiceRefusal reason="that link is not valid" />;
  }
  if (want === "revoked") {
    return (
      <InvoiceRefusal reason="that link has been withdrawn — ask for a fresh one and this invoice will open again" />
    );
  }

  const build = STATES[want] ?? STATES.unpaid!;
  return <InvoiceDocument doc={build()} />;
}
