import { expect } from "vitest";

/**
 * A NEGATIVE ASSERTION THAT CANNOT BE VACUOUS.
 *
 * `expect(code).not.toContain(x)` passes for two completely different reasons:
 * because the code is clean, or because `x` is something no code could ever
 * contain. The two are indistinguishable in a green test run, and the second
 * one is a guard that has quietly stopped guarding.
 *
 * That has now happened three times in this repo in three different ways:
 *   - a walker that collected `.ts` and was pointed at a tree of `.tsx`, so
 *     every rule built on it scanned an empty list;
 *   - an immutability rule matching a table name inside `db.patch(id, …)`,
 *     which can never contain one;
 *   - `.not.toMatch(/\berror\b/)` where the `\b` collapsed into a literal
 *     BACKSPACE character, producing a pattern nothing matches.
 *
 * Every one of them was found by planting a violation by hand and noticing the
 * test stayed green. That is a habit, and habits do not survive the session
 * they were learned in. This is the barrier version: the positive control
 * lives INSIDE the assertion, so a pattern that matches nothing fails on the
 * spot, whatever mangled it.
 *
 * Same shape as the control-on-the-control in the temp-file detector, which
 * plants a directory and asserts the detector sees it before trusting any
 * "no leftovers" result.
 */

type Absent = {
  /** What must not appear. A plain substring, or a pattern. */
  pattern: string | RegExp;
  /** The text being guarded — usually a source file with comments stripped. */
  from: string;
  /**
   * A SAMPLE THE PATTERN MUST MATCH.
   *
   * This is the whole point. Write the violation you are banning, exactly as
   * somebody would actually write it, and the assertion proves the pattern can
   * see it before concluding that it is absent.
   */
  provenBy: string;
  /** What the reader should do about it, if this ever fails. */
  because: string;
};

const hits = (pattern: string | RegExp, text: string): boolean =>
  typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);

const show = (pattern: string | RegExp): string =>
  typeof pattern === "string" ? JSON.stringify(pattern) : String(pattern);

/**
 * Assert `pattern` does not appear in `from`, having first proved it CAN
 * appear at all.
 */
export function expectAbsent({ pattern, from, provenBy, because }: Absent): void {
  /*
   * The control comes FIRST, deliberately. If the pattern is broken, that is
   * the failure worth reporting — a "clean" verdict from a pattern that
   * matches nothing is worse than useless, because it reads as safety.
   */
  expect(
    hits(pattern, provenBy),
    [
      `The pattern ${show(pattern)} does not match its own positive control.`,
      "",
      "It therefore matches nothing, and the absence it is about to report",
      "would mean nothing. Usually an escaping mistake — a `\\b` written",
      "through a generating script becomes a literal backspace, for instance.",
      "",
      `Control sample: ${JSON.stringify(provenBy)}`,
    ].join("\n"),
  ).toBe(true);

  const found = hits(pattern, from);
  expect(found, because).toBe(false);
}

/**
 * The same, for a list that must come back empty.
 *
 * A scan that collects offenders has the other vacuity problem: it can be
 * pointed at nothing. `examined` is what it actually looked at, and a scan
 * that looked at nothing fails rather than reporting an empty offender list.
 */
export function expectNoOffenders({
  offenders,
  examined,
  because,
}: {
  offenders: readonly string[];
  /** How many things were inspected. Zero means the scan found nothing to do. */
  examined: number;
  because: string;
}): void {
  expect(
    examined,
    "This scan examined nothing, so an empty offender list says nothing. " +
      "Check what it was pointed at.",
  ).toBeGreaterThan(0);

  expect(offenders, because).toEqual([]);
}
