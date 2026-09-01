// @vitest-environment node
import { describe, expect, test } from "vitest";
import { quickPresets, dayGrid } from "./callback-presets";

/**
 * The edge cases are all calendar edges, and every one of them produces a
 * plausible-looking time rather than an error — a callback booked for
 * Saturday 09:00 does not throw, it just never happens, and comes up on
 * Monday as though it was missed.
 *
 * Local time throughout, matching the module: the caller and the business
 * are in the same timezone, and the tests construct dates the same way the
 * UI will.
 */

const on = (iso: string) => new Date(iso);
const hhmm = (ms: number | null) => {
  if (ms === null) return null;
  const d = new Date(ms);
  return `${d.toDateString()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

describe("the four phrases people actually use", () => {
  test("mid-morning on a Tuesday offers later today, tomorrow, and Monday", () => {
    const presets = quickPresets(on("2026-09-01T10:00:00"));
    expect(presets.map((p) => p.key)).toEqual([
      "later-today",
      "next-morning",
      "next-afternoon",
      "monday",
    ]);
    expect(presets[0]?.label).toBe("Later today, 12:00");
    expect(presets[1]?.label).toBe("Tomorrow morning");
  });

  test("later today is two hours out, rounded to a time somebody would say", () => {
    expect(quickPresets(on("2026-09-01T10:20:00"))[0]?.label).toBe("Later today, 12:00");
    expect(quickPresets(on("2026-09-01T10:40:00"))[0]?.label).toBe("Later today, 12:30");
  });

  test("after 16:00 later today is GONE, not greyed out", () => {
    /*
     * +2h from 16:30 is 18:30, which is not a time to call a solar
     * installer. A dead-but-present option still costs a decision every time
     * it comes up, and this list is read forty times in an afternoon.
     */
    const presets = quickPresets(on("2026-09-01T16:30:00"));
    expect(presets.map((p) => p.key)).not.toContain("later-today");
  });
});

describe("weekends, where a plausible wrong answer is easy", () => {
  test("on a FRIDAY, tomorrow morning is Monday morning — and says so", () => {
    /*
     * The bug this exists to prevent: a callback booked for Saturday 09:00.
     * It does not error, it just never happens, and on Monday it surfaces as
     * overdue as though somebody dropped it.
     */
    const presets = quickPresets(on("2026-09-04T10:00:00")); // Friday
    const morning = presets.find((p) => p.key === "next-morning")!;
    expect(morning.label).toBe("Monday morning");
    expect(hhmm(morning.at)).toBe("Mon Sep 07 2026 09:00");
  });

  test("on a SATURDAY, everything rolls to Monday and later-today is gone", () => {
    const presets = quickPresets(on("2026-09-05T10:00:00")); // Saturday
    expect(presets.map((p) => p.key)).not.toContain("later-today");
    expect(hhmm(presets.find((p) => p.key === "next-morning")!.at)).toBe(
      "Mon Sep 07 2026 09:00",
    );
  });

  test("no two presets are the same TIME, whatever they are called", () => {
    /*
     * On a Friday "tomorrow morning" already IS Monday morning, so the
     * separate Monday button would be a second way to pick a time already on
     * screen — a choice that is not a choice.
     *
     * Asserted on the timestamps rather than the labels: an earlier version
     * of this test counted labels beginning "Monday" and failed on the
     * CORRECT output, because Monday morning and Monday afternoon are two
     * different times and should both be offered.
     */
    for (const day of ["2026-09-01", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-07"]) {
      const times = quickPresets(on(`${day}T10:00:00`)).map((p) => p.at);
      expect(new Set(times).size, day).toBe(times.length);
    }
  });

  test("on a Monday, 'Monday' means NEXT Monday, not today", () => {
    const presets = quickPresets(on("2026-09-07T10:00:00")); // Monday
    expect(hhmm(presets.find((p) => p.key === "monday")!.at)).toBe("Mon Sep 14 2026 09:00");
  });
});

describe("no preset ever lands in the past or out of hours", () => {
  test("across a full week of start times", () => {
    for (let day = 0; day < 7; day++) {
      for (const hour of [7, 9, 12, 15, 16, 17, 20]) {
        const now = new Date(2026, 8, 1 + day, hour, 0, 0, 0);
        for (const preset of quickPresets(now)) {
          if (preset.at === null) continue;
          const when = new Date(preset.at);
          expect(preset.at, `${preset.key} @ ${now}`).toBeGreaterThan(now.getTime());
          expect(when.getDay(), `${preset.key} landed on a weekend`).not.toBe(0);
          expect(when.getDay(), `${preset.key} landed on a weekend`).not.toBe(6);
          expect(when.getHours()).toBeGreaterThanOrEqual(9);
          expect(when.getHours()).toBeLessThanOrEqual(18);
        }
      }
    }
  });
});

describe("the day grid, for the two-tap case", () => {
  test("it skips weekends entirely rather than disabling them", () => {
    const grid = dayGrid(on("2026-09-03T10:00:00"), 6); // Thursday
    for (const row of grid) {
      const day = new Date(row.morning).getDay();
      expect(day).not.toBe(0);
      expect(day).not.toBe(6);
    }
    expect(grid).toHaveLength(6);
  });

  test("each row carries a morning and an afternoon, and names the date", () => {
    const grid = dayGrid(on("2026-09-01T10:00:00"), 3);
    expect(grid[0]?.label).toMatch(/Tomorrow 2 Sep/);
    expect(hhmm(grid[0]!.morning)).toBe("Wed Sep 02 2026 09:00");
    expect(hhmm(grid[0]!.afternoon)).toBe("Wed Sep 02 2026 14:00");
  });

  test("it never runs past a fortnight even when asked for more", () => {
    // A cold callback booked three weeks out is a lead nobody is chasing.
    expect(dayGrid(on("2026-09-01T10:00:00"), 50).length).toBeLessThanOrEqual(14);
  });
});
