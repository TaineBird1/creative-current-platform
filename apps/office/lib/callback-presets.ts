/**
 * WHEN A PROSPECT SAYS "CALL ME BACK".
 *
 * They say "later today", "tomorrow morning", "try me Monday". They do not
 * say "the fourth of September at fourteen hundred", which is what a
 * datetime picker asks for — four taps and a scroll wheel, one-handed, while
 * the person is still on the line.
 *
 * So these are the actual phrases, one tap each. Anything more specific is
 * two taps in the "another day" grid. There is no free-text time entry at
 * all: a callback is agreed in half-days on the phone, and pretending to
 * capture 11:15 records a precision the conversation did not have.
 *
 * TIMEZONE. Local time, deliberately, and this is NOT the same rule as
 * messaging quiet hours (which use the SITE's timezone, because the recipient
 * has none). Here the caller and the business are both in KZN: "tomorrow
 * morning" means the morning they are both going to have. If this platform
 * ever calls across timezones, this file is where that breaks and it should
 * break loudly rather than booking somebody's 04:00.
 */

const MORNING_HOUR = 9;
const AFTERNOON_HOUR = 14;
/** After this, "later today" would land outside the working day. */
const LAST_USEFUL_HOUR = 16;

export type Preset = {
  key: string;
  label: string;
  /** Epoch ms, or null when the option cannot apply right now. */
  at: number | null;
  /** Why it is unavailable, shown rather than leaving a dead button. */
  unavailable?: string;
};

const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

function at(base: Date, dayOffset: number, hour: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * The next day a business is open. Saturday and Sunday roll to Monday.
 *
 * A callback booked for Saturday 09:00 to a solar installer is a callback
 * that does not happen, and it is worse than useless: it sits in the queue on
 * a day nobody is working and comes up as overdue on Monday having been
 * "missed". The label follows the date, so on a Friday the button reads
 * "Monday morning" rather than lying about tomorrow.
 */
function nextBusinessDay(base: Date, from = 1): { offset: number; date: Date } {
  let offset = from;
  let date = at(base, offset, MORNING_HOUR);
  while (isWeekend(date)) {
    offset += 1;
    date = at(base, offset, MORNING_HOUR);
  }
  return { offset, date };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "tomorrow" only when it really is; otherwise name the day. */
function dayLabel(base: Date, offset: number): string {
  if (offset === 1) return "Tomorrow";
  return DAY_NAMES[at(base, offset, MORNING_HOUR).getDay()]!;
}

/**
 * The four that cover almost every callback, in the order they are said.
 */
export function quickPresets(now: Date): Preset[] {
  const hour = now.getHours();

  /*
   * "Later today" is two hours out, rounded up to the half hour so it reads
   * as a time somebody would say. It disappears rather than greying out after
   * 16:00 and at weekends: an option that is present but dead still costs a
   * decision every time it comes up.
   */
  const laterToday = new Date(now);
  laterToday.setHours(hour + 2, now.getMinutes() >= 30 ? 30 : 0, 0, 0);
  const laterUsable = !isWeekend(now) && hour < LAST_USEFUL_HOUR;

  const next = nextBusinessDay(now);
  const nextLabel = dayLabel(now, next.offset);

  /*
   * "Monday" means the START OF NEXT WEEK, which is what people mean by it.
   * On a Monday or Tuesday that is genuinely next Monday, not today.
   */
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;

  const presets: Preset[] = [];

  if (laterUsable) {
    presets.push({
      key: "later-today",
      label: `Later today, ${fmt(laterToday)}`,
      at: laterToday.getTime(),
    });
  }

  presets.push(
    {
      key: "next-morning",
      label: `${nextLabel} morning`,
      at: at(now, next.offset, MORNING_HOUR).getTime(),
    },
    {
      key: "next-afternoon",
      label: `${nextLabel} afternoon`,
      at: at(now, next.offset, AFTERNOON_HOUR).getTime(),
    },
  );

  // Only worth offering when it is not already one of the two above.
  if (daysToMonday !== next.offset) {
    presets.push({
      key: "monday",
      label: "Monday morning",
      at: at(now, daysToMonday, MORNING_HOUR).getTime(),
    });
  }

  return presets;
}

/**
 * The next working days, each with a morning and an afternoon.
 *
 * Two taps for anything inside a fortnight, which is further ahead than a
 * cold callback is ever usefully booked. Weekends are absent rather than
 * disabled — the grid is short enough that a row nobody can use is just noise.
 */
export function dayGrid(now: Date, days = 8): { label: string; morning: number; afternoon: number }[] {
  const out: { label: string; morning: number; afternoon: number }[] = [];
  for (let offset = 1; out.length < days && offset < 21; offset++) {
    const day = at(now, offset, MORNING_HOUR);
    if (isWeekend(day)) continue;
    out.push({
      label: `${dayLabel(now, offset)} ${day.getDate()} ${day.toLocaleDateString("en-ZA", { month: "short" })}`,
      morning: day.getTime(),
      afternoon: at(now, offset, AFTERNOON_HOUR).getTime(),
    });
  }
  return out;
}

/** 24-hour, because that is how a time is said and read here. */
function fmt(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
