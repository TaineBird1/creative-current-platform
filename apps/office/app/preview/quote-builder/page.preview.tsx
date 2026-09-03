import { notFound } from "next/navigation";
import { buildAccentRamp } from "@cc/site-config";
import { accentStyle } from "@/lib/accent-css";
import { QuoteBuilder } from "../../c/[slug]/quotes/QuoteBuilder";
import s from "../../c/[slug]/back-office.module.css";

/**
 * THE QUOTE BUILDER, WITH FIXTURES.
 *
 * The screen is behind an emailed sign-in code, which is exactly what stopped
 * the bookings screen being looked at for three sessions — and that cost three
 * rendering bugs no test could see. This is the same fix applied before the
 * same thing happens again.
 *
 * It renders `QuoteBuilder` — the SAME component `/c/<slug>/quotes` renders,
 * not a copy. A harness that duplicates markup stops telling the truth the
 * first time somebody edits one of the two, silently.
 *
 * FIXTURES ARE OBVIOUSLY FAKE: `@example.com` (RFC 2606 — cannot be
 * registered, never resolves) and round numbers no survey would produce. A
 * screenshot that escapes must not be mistaken for a real customer's quote.
 *
 * WHAT IS DIFFERENT FROM THE OTHER HARNESSES, said out loud rather than left
 * to be discovered. The bookings and invoice fixtures render pure components.
 * This one is INTERACTIVE — the builder holds state and calls mutations — so
 * the buttons are live. They reach nothing:
 *
 *   `slugFromPath()` reads the second path segment, which here is
 *   "quote-builder" and is not a client slug. Every tenant mutation
 *   re-derives its tenant from the caller's own memberships, so an
 *   unauthenticated visitor gets refused and a signed-in one gets NOT_FOUND —
 *   indistinguishable from an unknown slug, by design.
 *
 * So the harness cannot write to a real tenant, which is the property the
 * FIXTURES-ONLY guard exists to protect. It is stated here because the guard
 * scans this file for Convex imports and finds none — the mutations arrive
 * through the component — and a reader deserves to know that rather than
 * infer it.
 *
 * SAME THREE BARRIERS as every other preview, every default off: the file is
 * `page.preview.tsx` so Next does not route it; `ALLOW_PREVIEW_ROUTES` is
 * absent from turbo.json so a Vercel build cannot see the flag; and it refuses
 * below regardless. `scripts/assert-no-preview-route.mjs` reads the built
 * manifest in CI rather than trusting any of the three.
 *
 *   pnpm dev:preview
 *   http://localhost:3200/preview/quote-builder
 */
export const dynamic = "force-dynamic";

const DAY = 24 * 60 * 60 * 1000;

/** Requests waiting to be priced — the entry point to the whole screen. */
const REQUESTS = [
  {
    _id: "qr1" as never,
    status: "new" as const,
    name: "Thandi Example",
    phone: "+27825550001",
    email: "thandi@example.com",
    answers: [
      { key: "Roof type", value: "Tile, double storey" },
      { key: "Monthly bill", value: "R 4 200" },
      { key: "Backup wanted", value: "Yes — fridge, lights, Wi-Fi" },
      { key: "Suburb", value: "Hillcrest" },
    ],
    submittedAt: Date.now() - 2 * 60 * 60 * 1000,
    isDemo: false,
  },
  {
    _id: "qr2" as never,
    status: "contacted" as const,
    name: "Example Body Corporate",
    // A request with no number: the row must say so rather than render a
    // dial link that does nothing.
    phone: null,
    email: "trustees@example.com",
    answers: [{ key: "Units", value: "24" }],
    submittedAt: Date.now() - 3 * DAY,
    isDemo: false,
  },
];

/**
 * Every state the list has. The ones that go wrong are the states written for
 * the ordinary case only — an expired quote still offering "Send again" would
 * re-send a price the business will not honour.
 */
const QUOTES = [
  {
    _id: "q1" as never,
    number: "QUO-0004",
    status: "draft" as const,
    customerId: "c1" as never,
    customerName: "Thandi Example",
    lineItems: [
      { description: "8kW hybrid inverter, fitted", quantity: 1, unitPriceCents: 4_800_000, taxable: false },
      { description: "455W panels", quantity: 12, unitPriceCents: 320_000, taxable: false },
    ],
    subtotalCents: 8_640_000,
    totalCents: 8_640_000,
    currency: "ZAR" as const,
    expiresAt: Date.now() + 12 * DAY,
    acceptedAt: null,
    isExpired: false,
    isDemo: false,
  },
  {
    _id: "q2" as never,
    number: "QUO-0003",
    status: "sent" as const,
    customerId: "c2" as never,
    customerName: "Example Body Corporate",
    lineItems: [
      { description: "Panel clean — 24 panels", quantity: 24, unitPriceCents: 25_000, taxable: false },
    ],
    subtotalCents: 600_000,
    totalCents: 600_000,
    currency: "ZAR" as const,
    expiresAt: Date.now() + 4 * DAY,
    acceptedAt: null,
    isExpired: false,
    isDemo: false,
  },
  {
    _id: "q3" as never,
    number: "QUO-0002",
    status: "accepted" as const,
    customerId: "c3" as never,
    customerName: "Sipho Example",
    lineItems: [
      { description: "5.1kWh battery, supplied and fitted", quantity: 2, unitPriceCents: 2_100_000, taxable: false },
    ],
    subtotalCents: 4_200_000,
    totalCents: 4_200_000,
    currency: "ZAR" as const,
    expiresAt: Date.now() - 2 * DAY,
    acceptedAt: Date.now() - 5 * DAY,
    isExpired: false,
    isDemo: false,
  },
  {
    _id: "q4" as never,
    number: "QUO-0001",
    status: "sent" as const,
    customerId: "c4" as never,
    customerName: "Nomsa Example",
    lineItems: [
      { description: "Site assessment", quantity: 1, unitPriceCents: 150_000, taxable: false },
    ],
    subtotalCents: 150_000,
    totalCents: 150_000,
    currency: "ZAR" as const,
    expiresAt: Date.now() - 6 * DAY,
    acceptedAt: null,
    // Derived by the query, never stored — so it is true whenever anyone looks.
    isExpired: true,
    isDemo: false,
  },
];

export default function QuoteBuilderPreview({
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
  const empty = params.empty === "1";

  /*
   * A BRAND COLOUR, because without one the harness lies about what ships.
   * `.world-client` falls back to neutral ink when no ramp is injected, so an
   * un-tinted preview shows every action in the wrong colour — and the accent
   * is the one thing that differs per client on this screen.
   *
   * It arrives as data and goes through the AA-validated ramp, same as the
   * bookings harness and the sites preview.
   */
  const brandParam = typeof params.brand === "string" ? params.brand : "#1f6f43";
  let ramp;
  try {
    ramp = buildAccentRamp(brandParam);
  } catch {
    ramp = buildAccentRamp("#1f6f43");
  }

  return (
    <div className="world-client" style={accentStyle(ramp)}>
      <header className={s.bar}>
        <div>
          <h1 className={s.heading}>Quotes</h1>
          <p className={s.today}>Example Solar</p>
        </div>
      </header>

      <main className={s.main}>
        <QuoteBuilder
          quotes={empty ? [] : QUOTES}
          requests={empty ? [] : REQUESTS}
          currency="ZAR"
        />
      </main>
    </div>
  );
}
