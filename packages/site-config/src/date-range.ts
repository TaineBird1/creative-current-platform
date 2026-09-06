/**
 * A TRAVEL DATE RANGE, CARRIED AS ONE ANSWER.
 *
 * Quote answers are `Record<string, string>` — one string per declared field —
 * so a range has to survive as a single value. It is stored as an ISO 8601
 * interval, `YYYY-MM-DD/YYYY-MM-DD`.
 *
 * WHY A STANDARD RATHER THAN "12-19 July 2027". The obvious cheap option is a
 * `text` field, and it works on the day it ships and never again: the string
 * cannot be sorted, filtered, or put on a calendar, and nobody can tell
 * 03/04 from 04/03 afterwards. Two of the three planned niches need to READ
 * this back — a guest house's check-in/check-out is the same field, and it is
 * the one a booking is made from. A value you cannot parse is a value that
 * has to be re-asked for.
 *
 * ONE IMPLEMENTATION, USED BY BOTH SIDES. `apps/sites` writes it in the
 * browser and `convex/public/quote.ts` validates it on the server. Two
 * opinions about the format would be two opinions about which enquiries are
 * accepted — the same argument that left `toE164` the only phone normaliser
 * in the codebase after three of them disagreed.
 *
 * IT REFUSES RATHER THAN GUESSING, for the same reason `toE164` does. A
 * parser that always returns something turns a malformed range into a value
 * that looks answered and means nothing.
 */

/** ISO 8601 interval separator. Not a dash: dates already contain those. */
export const DATE_RANGE_SEPARATOR = "/";

export type DateRange = {
  /** Inclusive start, `YYYY-MM-DD`. */
  start: string;
  /** Inclusive end, `YYYY-MM-DD`. Never earlier than `start`. */
  end: string;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar day, not merely a well-shaped string.
 *
 * THE ROUND-TRIP IS THE WHOLE CHECK, and dropping it is the easy mistake:
 * `Date.parse("2027-02-30")` does not fail. It returns 2 March, silently, so
 * a regex plus a parse accepts a day that does not exist and stores a range
 * ending on a date the customer never picked. Comparing the parsed date back
 * against the input is what catches it.
 */
function isRealDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  // Anchored to UTC midnight deliberately: this is a calendar day with no
  // time and no zone. Parsing it as local time shifts the day either side of
  // the meridian, which would make the same enquiry mean two different dates.
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(stamp)) return false;
  return new Date(stamp).toISOString().slice(0, 10) === value;
}

/**
 * Parse a stored range. `null` means the value is unusable — never a guess,
 * and never a partially-filled range treated as complete.
 */
export function parseDateRange(value: string): DateRange | null {
  const parts = value.trim().split(DATE_RANGE_SEPARATOR);
  if (parts.length !== 2) return null;

  const start = parts[0]?.trim() ?? "";
  const end = parts[1]?.trim() ?? "";
  if (!isRealDay(start) || !isRealDay(end)) return null;

  /*
   * Lexicographic comparison is correct here and only here: ISO days are
   * fixed-width and zero-padded, so string order IS date order. It would be
   * wrong the moment the format changed, which is why the format is pinned
   * by `isRealDay` above rather than assumed.
   */
  if (end < start) return null;

  return { start, end };
}

/**
 * Build the stored value from two days.
 *
 * Returns the raw joined string WITHOUT validating, because a half-finished
 * range has to survive in the form while somebody is still choosing — they
 * pick a start before they pick an end. Validation happens on submit, on both
 * sides. `parseDateRange` is the thing that says whether it is usable.
 */
export function joinDateRange(start: string, end: string): string {
  return `${start}${DATE_RANGE_SEPARATOR}${end}`;
}

/** The two halves of a possibly-incomplete stored value, for form inputs. */
export function splitDateRange(value: string): { start: string; end: string } {
  const parts = (value ?? "").split(DATE_RANGE_SEPARATOR);
  return { start: parts[0] ?? "", end: parts[1] ?? "" };
}

/**
 * PAST DATES ARE ACCEPTED, and that is a decision rather than an omission.
 *
 * Which error is recoverable? Refusing a genuine enquiry loses the work
 * outright — the customer goes elsewhere and nobody ever knows. Accepting an
 * odd date costs a phone call, and a travel agent rings every enquiry anyway.
 * Same answer as an unnormalisable phone number on a booking: record it, and
 * let a person sort it out.
 *
 * Exported so a screen can SAY a range is in the past without this module
 * deciding to refuse it.
 */
export function isPastRange(range: DateRange, now: number = Date.now()): boolean {
  return Date.parse(`${range.end}T23:59:59Z`) < now;
}
