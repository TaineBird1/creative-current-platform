import { notFound } from "next/navigation";
import { buildAccentRamp } from "@cc/site-config";
import type { UpcomingBookings } from "@cc/convex-src/bookings";
import { accentStyle } from "@/lib/accent-css";
import { Bookings } from "../../c/[slug]/Bookings";
import s from "../../c/[slug]/back-office.module.css";

/**
 * THE CLIENT'S DAY, WITH NO BACKEND.
 *
 * `apps/sites` has had `/preview` since the first template, and for the reason
 * that applies here too: a screen cannot be judged from source, and the back
 * office is behind an emailed sign-in code — so without this, the only way to
 * look at the calendar is to be a signed-in client who already has bookings,
 * which is nobody until the day it matters most.
 *
 * It renders FIXTURES through the real component. Not a mock of the component:
 * the same file, the same stylesheet, so what is reviewed here is what ships.
 *
 * IT CANNOT EXIST IN PRODUCTION, and that is a stronger claim than the one
 * this file made first.
 *
 * The first version compared VERCEL_ENV at runtime, by analogy with the sites
 * preview. The analogy was wrong: that harness renders invented marketing copy
 * on a public template, and this one renders the shape of a TENANT'S BOOKINGS
 * — customer names and phone numbers. A runtime string comparison is one bad
 * environment variable away from publishing a client's customer list, and the
 * failure is silent and public.
 *
 * So there are three independent barriers, and the default of every one is
 * off:
 *
 *  1. THE FILE IS NOT A PAGE. It is named `page.preview.tsx`, which Next does
 *     not route unless `preview.tsx` is in pageExtensions. Without the flag
 *     the route is not in the manifest and not in the bundle.
 *  2. THE BUILD CANNOT SEE THE FLAG. `ALLOW_PREVIEW_ROUTES` is deliberately
 *     absent from turbo.json, and Turborepo filters the environment to what a
 *     task declares — so setting it in the Vercel dashboard does nothing.
 *  3. AND IT STILL REFUSES. The check below runs before anything renders, and
 *     absent means no.
 *
 * FIXTURES ONLY, FOREVER. Nothing here may read the backend. A harness that
 * can be pointed at a real tenant is the thing all of the above exists to
 * prevent, so guards.test.ts fails on a Convex import anywhere under
 * `app/preview`.
 */
export const dynamic = "force-dynamic";

const JHB = "Africa/Johannesburg";

/** Today at a fixed local hour, so the fixture reads the same at any hour. */
function at(dayOffset: number, hour: number, minute = 0): number {
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: JHB, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [y, m, d] = local.split("-").map(Number);
  // JHB is UTC+2 all year, which is the one place this fixture may assume it.
  return Date.UTC(y!, m! - 1, d! + dayOffset, hour - 2, minute);
}

const HOUR = 60 * 60 * 1000;

/** The real key shape, so dayLabel is exercised rather than side-stepped. */
function key(dayOffset: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JHB, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(at(dayOffset, 12)));
}

const FIXTURE: UpcomingBookings = {
  timezone: JHB,
  todayKey: new Intl.DateTimeFormat("en-CA", {
    timeZone: JHB, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()),
  today: [
    {
      _id: "b1" as never,
      dayKey: key(0),
      startsAt: at(0, 8),
      endsAt: at(0, 8) + HOUR,
      status: "confirmed",
      serviceName: "Site assessment",
      locationName: "Hillcrest",
      customerName: "Thabo Mokoena",
      customerPhone: "+27825551234",
      notes: null,
      confirmation: { state: "sent", detail: null, channel: "email" },
    },
    {
      _id: "b2" as never,
      dayKey: key(0),
      startsAt: at(0, 10, 30),
      endsAt: at(0, 10, 30) + 2 * HOUR,
      status: "confirmed",
      serviceName: "Inverter install — 8kW",
      locationName: "Hillcrest",
      customerName: "Priya Naidoo",
      customerPhone: "+27834447788",
      notes: "Gate code 4471. Dogs — phone from the road.",
      confirmation: { state: "not_sent", detail: null, channel: "whatsapp" },
    },
    {
      _id: "b3" as never,
      dayKey: key(0),
      startsAt: at(0, 14),
      endsAt: at(0, 14) + HOUR,
      status: "cancelled",
      serviceName: "Site assessment",
      locationName: "Kloof",
      customerName: "Johannes van der Merwe",
      customerPhone: "+27829990001",
      notes: null,
      confirmation: { state: "sent", detail: null, channel: "email" },
    },
    {
      _id: "b4" as never,
      dayKey: key(0),
      startsAt: at(0, 16),
      endsAt: at(0, 16) + HOUR,
      status: "pending",
      serviceName: "Battery quote follow-up",
      locationName: null,
      customerName: "Nomsa Dlamini",
      customerPhone: null,
      notes: null,
      confirmation: { state: "queued", detail: null, channel: "email" },
    },
  ],
  days: [
    {
      dayKey: key(1),
      bookings: [
        {
          _id: "b5" as never,
          dayKey: key(1),
          startsAt: at(1, 7, 30),
          endsAt: at(1, 7, 30) + 3 * HOUR,
          status: "confirmed",
          serviceName: "Panel clean — 24 panels",
          locationName: "Waterfall",
          customerName: "Ridgeview Body Corporate",
          customerPhone: "+27317654321",
          notes: null,
          confirmation: { state: "sent", detail: null, channel: "email" },
        },
      ],
    },
    {
      dayKey: key(3),
      bookings: [
        {
          _id: "b6" as never,
          dayKey: key(3),
          startsAt: at(3, 9),
          endsAt: at(3, 9) + HOUR,
          status: "confirmed",
          serviceName: "Site assessment",
          locationName: "Hillcrest",
          customerName: "Sipho Khumalo",
          customerPhone: "+27821112233",
          notes: null,
          confirmation: { state: "sent", detail: null, channel: "email" },
        },
      ],
    },
  ],
};

export default function BookingsPreview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Barrier 3. Absent means no — the same direction as every other default in
  // this codebase, and the only one that is safe when somebody is wrong.
  if (process.env.ALLOW_PREVIEW_ROUTES !== "1") notFound();
  return <Preview searchParams={searchParams} />;
}

async function Preview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const brandParam = typeof params.brand === "string" ? params.brand : "#1f6f43";
  const empty = params.empty === "1";

  // A brand colour is CONTENT here, the same as it is on the sites preview
  // route: it arrives as data and goes through the AA-validated ramp.
  let ramp;
  try {
    ramp = buildAccentRamp(brandParam);
  } catch {
    ramp = buildAccentRamp("#1f6f43");
  }

  const data: UpcomingBookings = empty
    ? { ...FIXTURE, today: [], days: [] }
    : FIXTURE;

  return (
    <div className="world-client" style={accentStyle(ramp)}>
      <header className={s.bar}>
        <div>
          <h1 className={s.heading}>Renu Solar</h1>
          <p className={s.today}>
            {new Intl.DateTimeFormat("en-ZA", {
              timeZone: JHB,
              weekday: "long",
              day: "numeric",
              month: "long",
            }).format(new Date())}
          </p>
        </div>
      </header>
      <Bookings data={data} />
    </div>
  );
}
