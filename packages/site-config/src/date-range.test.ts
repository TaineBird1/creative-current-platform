import { describe, expect, test } from "vitest";
import {
  isPastRange,
  joinDateRange,
  parseDateRange,
  splitDateRange,
} from "./date-range";

describe("a travel date range survives as one answer", () => {
  test("a valid range round-trips", () => {
    const value = joinDateRange("2027-07-12", "2027-07-19");
    expect(value).toBe("2027-07-12/2027-07-19");
    expect(parseDateRange(value)).toEqual({
      start: "2027-07-12",
      end: "2027-07-19",
    });
  });

  test("a single day is a range", () => {
    // A day trip is a real enquiry. Same start and end is not a mistake.
    expect(parseDateRange("2027-07-12/2027-07-12")).toEqual({
      start: "2027-07-12",
      end: "2027-07-12",
    });
  });

  test("surrounding whitespace does not change the answer", () => {
    expect(parseDateRange("  2027-07-12 / 2027-07-19  ")).toEqual({
      start: "2027-07-12",
      end: "2027-07-19",
    });
  });
});

describe("it refuses rather than guessing", () => {
  /**
   * THE ONE THAT A REGEX PLUS A PARSE LETS THROUGH.
   *
   * `Date.parse("2027-02-30")` does not fail — it returns 2 March. So a
   * well-shaped string naming a day that does not exist would be stored as a
   * range ending on a date the customer never picked, silently. The round
   * trip in `isRealDay` is the only thing that catches it, and this test is
   * why that round trip cannot be tidied away as redundant.
   */
  test("a day that does not exist", () => {
    expect(parseDateRange("2027-02-30/2027-03-05")).toBeNull();
    expect(parseDateRange("2027-07-12/2027-13-01")).toBeNull();
    expect(parseDateRange("2027-07-12/2027-07-32")).toBeNull();
  });

  test("29 February is real in a leap year and not otherwise", () => {
    expect(parseDateRange("2028-02-29/2028-03-01")).not.toBeNull();
    expect(parseDateRange("2027-02-29/2027-03-01")).toBeNull();
  });

  test("a return before the departure", () => {
    expect(parseDateRange("2027-07-19/2027-07-12")).toBeNull();
  });

  test("a half-picked range, which is what a form actually produces", () => {
    // Truthy, so a bare `required` check waves it through. This is the case
    // the server's shape check exists for.
    expect(parseDateRange("2027-07-12/")).toBeNull();
    expect(parseDateRange("/2027-07-19")).toBeNull();
  });

  test("free text, which is what the field replaces", () => {
    expect(parseDateRange("12-19 July 2027")).toBeNull();
    expect(parseDateRange("")).toBeNull();
    expect(parseDateRange("sometime in July")).toBeNull();
  });

  test("a third part", () => {
    expect(parseDateRange("2027-07-12/2027-07-19/2027-07-26")).toBeNull();
  });

  test("a shape that is not zero-padded", () => {
    // The lexicographic comparison in parseDateRange is only correct for
    // fixed-width days, so the format has to be pinned rather than assumed.
    expect(parseDateRange("2027-7-12/2027-7-19")).toBeNull();
  });
});

describe("a partial range survives in the form", () => {
  test("split returns both halves, present or not", () => {
    expect(splitDateRange("2027-07-12/2027-07-19")).toEqual({
      start: "2027-07-12",
      end: "2027-07-19",
    });
    expect(splitDateRange("2027-07-12/")).toEqual({
      start: "2027-07-12",
      end: "",
    });
    expect(splitDateRange("")).toEqual({ start: "", end: "" });
  });

  test("join does not validate, so a half-choice is not blanked", () => {
    // Deliberate: somebody picks a departure before a return, and the form
    // must not throw their first choice away while they make the second.
    expect(joinDateRange("2027-07-12", "")).toBe("2027-07-12/");
    expect(parseDateRange(joinDateRange("2027-07-12", ""))).toBeNull();
  });
});

describe("past ranges are reported, never refused", () => {
  const now = Date.parse("2027-08-01T12:00:00Z");

  test("a finished trip is past", () => {
    expect(isPastRange({ start: "2027-07-12", end: "2027-07-19" }, now)).toBe(true);
  });

  test("a trip ending today is not past", () => {
    expect(isPastRange({ start: "2027-07-25", end: "2027-08-01" }, now)).toBe(false);
  });

  test("and parsing still accepts it, because refusing loses the enquiry", () => {
    // The recoverable error is a phone call. The unrecoverable one is a
    // customer who filled the form in and went elsewhere.
    expect(parseDateRange("2020-01-01/2020-01-08")).not.toBeNull();
  });
});
