/**
 * WHAT "TODAY" MEANS, IN SOMEBODY ELSE'S TIMEZONE.
 *
 * The server runs in UTC and the Vercel functions run in Dublin. A client in
 * Durban opening their calendar at 01:00 their time must not be shown
 * yesterday, and one opening it at 23:00 must not be shown tomorrow — so the
 * day boundary is computed against the CLIENT's timezone, which is a column on
 * their row, and never against the clock the code happens to be running on.
 *
 * This is the same class of mistake as `quietHoursTimezone` and gets the same
 * treatment: the timezone is data, the arithmetic happens once, here.
 *
 * NO DATE LIBRARY. Intl is in the Convex runtime and is the only correct way
 * to read a wall clock in another zone; offset arithmetic by hand is wrong
 * twice a year, in the places that have DST.
 *
 * DST IS HANDLED, and it was not on the first attempt: sampling the offset at
 * midday and applying it to midnight puts the boundary an hour out in a zone
 * that shifted overnight. A test across the New York fall-back caught it. The
 * fix is one refinement pass — see startOfLocalDay.
 *
 * What remains approximate is only the hour that repeats or does not exist at
 * the shift itself, which no representation of a wall clock can resolve.
 * South Africa has no DST, so this is exact for every client on the platform
 * today regardless.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The wall-clock parts of an instant, in a named zone. `en-CA` because it
 * formats as YYYY-MM-DD, which sorts and parses without a second thought.
 */
function parts(at: number, timeZone: string): { year: number; month: number; day: number } {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
  const [year, month, day] = formatted.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

/**
 * How far the zone is from UTC at this instant, in milliseconds.
 *
 * Derived by formatting the instant AS IF it were UTC and subtracting: the
 * gap between "what the clock says there" and "what the clock says here" is
 * the offset, and Intl is what makes it correct for a zone whose rules we do
 * not have to know.
 */
export function zoneOffsetMs(at: number, timeZone: string): number {
  const there = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));

  const get = (type: string) => Number(there.find((p) => p.type === type)?.value ?? "0");
  // `hour12: false` renders midnight as 24 in some engines. Normalise it.
  const hour = get("hour") % 24;

  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  // Sub-second precision is irrelevant to a day boundary and its absence
  // would otherwise make the offset jitter by up to 999ms.
  return asIfUtc - Math.floor(at / 1000) * 1000;
}

/** The instant at which the client's own day began. */
export function startOfLocalDay(at: number, timeZone: string): number {
  const { year, month, day } = parts(at, timeZone);
  const midnight = Date.UTC(year, month - 1, day);

  /*
   * TWO PASSES, AND THE SECOND ONE IS THE POINT.
   *
   * The offset is sampled at `at` — often the middle of the day — and then
   * applied to MIDNIGHT, which in a zone that shifted overnight had a
   * different offset. A test across the New York fall-back caught it landing
   * on 01:00 rather than 00:00.
   *
   * So the first pass is a guess, and the second re-samples the offset at that
   * guess, which is within an hour of the real boundary and therefore on the
   * right side of the shift. One refinement converges for every real zone;
   * none of them move by more than an hour.
   */
  const guess = midnight - zoneOffsetMs(at, timeZone);
  return midnight - zoneOffsetMs(guess, timeZone);
}

/** The instant `days` local days after the start of the day containing `at`. */
export function startOfLocalDayPlus(at: number, timeZone: string, days: number): number {
  const anchor = startOfLocalDay(at, timeZone) + days * DAY_MS;
  // Re-derive from the anchor so a DST shift inside the range lands on the
  // real local midnight rather than 23:00 or 01:00.
  return startOfLocalDay(anchor + DAY_MS / 2, timeZone);
}

/** `2026-09-02`, in the client's zone. Stable, sortable, and not a display string. */
export function localDayKey(at: number, timeZone: string): string {
  const { year, month, day } = parts(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
