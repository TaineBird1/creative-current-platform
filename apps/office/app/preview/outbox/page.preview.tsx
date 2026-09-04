import { notFound } from "next/navigation";
import { buildAccentRamp } from "@cc/site-config";
import { accentStyle } from "@/lib/accent-css";
import { Outbox } from "../../c/[slug]/messages/Outbox";
import s from "../../c/[slug]/back-office.module.css";

/**
 * THE OUTBOX, WITH FIXTURES.
 *
 * Every state at once, which is the only way to see whether the failures
 * really do read louder than the successes — the entire information design of
 * this screen is that claim, and it is not checkable from source.
 *
 * It renders `Outbox` — the SAME component `/c/<slug>/messages` renders, not a
 * copy. FIXTURES ARE OBVIOUSLY FAKE: `@example.com` (RFC 2606, cannot be
 * registered, never resolves) and numbers that are visibly placeholders.
 *
 * SAME THREE BARRIERS as every other preview, every default off: the file is
 * `page.preview.tsx` so Next does not route it; `ALLOW_PREVIEW_ROUTES` is
 * absent from turbo.json so a Vercel build cannot see the flag; and it refuses
 * below regardless. `scripts/assert-no-preview-route.mjs` reads the built
 * manifest in CI rather than trusting any of the three.
 *
 *   pnpm dev:preview
 *   http://localhost:3200/preview/outbox
 */
export const dynamic = "force-dynamic";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ROWS = [
  /* --- the ones that did not arrive, which is why anybody opens this --- */
  {
    _id: "m1" as never,
    status: "failed",
    channel: "email",
    templateKey: "booking_confirmation",
    to: "thandi@exmaple.com",
    scheduledFor: Date.now() - 3 * HOUR,
    sentAt: null,
    attempts: 5,
    providerName: null,
    customerName: "Thandi Example",
  },
  {
    _id: "m2" as never,
    status: "suppressed_consent",
    channel: "whatsapp",
    templateKey: "review_request",
    to: "+27825550002",
    scheduledFor: Date.now() - 8 * HOUR,
    sentAt: null,
    attempts: 0,
    providerName: null,
    customerName: "Sipho Example",
  },
  {
    _id: "m3" as never,
    status: "suppressed_lead",
    channel: "email",
    templateKey: "quote_sent",
    to: "info@example.com",
    scheduledFor: Date.now() - 30 * HOUR,
    sentAt: null,
    attempts: 0,
    providerName: null,
    customerName: "Example Renewables",
  },

  /* --- in flight --- */
  {
    _id: "m4" as never,
    status: "holding_quiet_hours",
    channel: "email",
    templateKey: "reminder_24h",
    to: "nomsa@example.com",
    scheduledFor: Date.now() + 9 * HOUR,
    sentAt: null,
    attempts: 0,
    providerName: null,
    customerName: "Nomsa Example",
  },
  {
    _id: "m5" as never,
    status: "scheduled",
    channel: "email",
    templateKey: "reminder_1h",
    to: "priya@example.com",
    scheduledFor: Date.now() + 20 * MIN,
    sentAt: null,
    attempts: 0,
    providerName: null,
    customerName: "Priya Example",
  },

  /* --- and the ordinary majority --- */
  {
    _id: "m6" as never,
    status: "sent",
    channel: "email",
    templateKey: "booking_confirmation",
    to: "priya@example.com",
    scheduledFor: Date.now() - 2 * HOUR,
    sentAt: Date.now() - 2 * HOUR,
    attempts: 1,
    providerName: "resend",
    customerName: "Priya Example",
  },
  {
    _id: "m7" as never,
    status: "sent",
    channel: "email",
    templateKey: "quote_sent",
    to: "trustees@example.com",
    scheduledFor: Date.now() - DAY,
    sentAt: Date.now() - DAY,
    attempts: 1,
    providerName: "resend",
    customerName: "Example Body Corporate",
  },
  {
    /*
     * Client-directed: `dispatchToClient` writes no customerId, so the row has
     * no customer name and the screen says "You". Without this fixture that
     * branch is never seen.
     */
    _id: "m8" as never,
    status: "sent",
    channel: "email",
    templateKey: "invoice_issued",
    to: "owner@example.com",
    scheduledFor: Date.now() - 3 * DAY,
    sentAt: Date.now() - 3 * DAY,
    attempts: 1,
    providerName: "resend",
    customerName: null,
  },
  {
    /* A row with nowhere to send: the address column must say so. */
    _id: "m9" as never,
    status: "failed",
    channel: "email",
    templateKey: "booking_confirmation",
    to: "",
    scheduledFor: Date.now() - 5 * DAY,
    sentAt: null,
    attempts: 0,
    providerName: null,
    customerName: "Johannes Example",
  },
];

export default function OutboxPreview({
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
  /* `clean` is the state a working deployment is in most of the time, and it
     must not look like an error page just because the top section is gone. */
  const clean = params.clean === "1";

  const brandParam = typeof params.brand === "string" ? params.brand : "#1f6f43";
  let ramp;
  try {
    ramp = buildAccentRamp(brandParam);
  } catch {
    ramp = buildAccentRamp("#1f6f43");
  }

  const rows = empty
    ? []
    : clean
      ? ROWS.filter((r) => r.status === "sent" || r.status === "scheduled")
      : ROWS;

  return (
    <div className="world-client" style={accentStyle(ramp)}>
      <header className={s.bar}>
        <div>
          <h1 className={s.heading}>Messages</h1>
          <p className={s.today}>Example Solar</p>
        </div>
      </header>

      <main className={s.main}>
        <Outbox rows={rows} timezone="Africa/Johannesburg" />
      </main>
    </div>
  );
}
