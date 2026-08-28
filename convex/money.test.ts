// @vitest-environment node
import { describe, expect, test } from "vitest";
import { assertCents, assertMoney, scaleCents, sumCents, formatCents } from "./lib/money";

/**
 * Money is integer cents in a plain number. float64 gives exactness up to
 * 2^53 for free; what it does NOT give is integer-ness. These tests pin the
 * choke point that supplies it.
 */

describe("assertCents", () => {
  test("accepts whole cents, including zero and negatives", () => {
    expect(assertCents(0)).toBe(0);
    expect(assertCents(950_000)).toBe(950_000);
    expect(assertCents(-45_00)).toBe(-4500);
  });

  test("rejects fractional cents -- the actual bug this guards", () => {
    expect(() => assertCents(12.5)).toThrow(/whole cents/);
    // 15% of R33.33 computed carelessly.
    expect(() => assertCents(3333 * 0.15)).toThrow(/whole cents/);
  });

  test("rejects NaN and Infinity", () => {
    expect(() => assertCents(NaN)).toThrow(/not finite/);
    expect(() => assertCents(Infinity)).toThrow(/not finite/);
    expect(() => assertCents(0 / 0)).toThrow(/not finite/);
  });

  test("names the offending field in the message", () => {
    expect(() => assertCents(1.5, "totalCents")).toThrow(/totalCents/);
  });

  test("R90 trillion is still exact -- the reason bigint is not needed", () => {
    const ninetyTrillionRand = 9_000_000_000_000_000; // cents
    expect(assertCents(ninetyTrillionRand)).toBe(ninetyTrillionRand);
    expect(ninetyTrillionRand + 1).toBe(ninetyTrillionRand + 1);
  });

  test("survives JSON.stringify -- the reason bigint IS a problem", () => {
    expect(JSON.stringify({ amountCents: assertCents(129_500) })).toBe(
      '{"amountCents":129500}',
    );
    expect(() => JSON.stringify({ amountCents: 129500n })).toThrow(TypeError);
  });
});

describe("assertMoney", () => {
  test("checks every named field and ignores absent ones", () => {
    const doc = { subtotalCents: 100_000, taxCents: undefined, totalCents: 100_000 };
    expect(assertMoney(doc, ["subtotalCents", "taxCents", "totalCents"])).toBe(doc);
  });

  test("throws on the first bad field, naming it", () => {
    const doc = { subtotalCents: 100_000, taxCents: 15_000.5 };
    expect(() => assertMoney(doc, ["subtotalCents", "taxCents"])).toThrow(/taxCents/);
  });
});

describe("scaleCents", () => {
  test("quantity multiplication stays whole", () => {
    expect(scaleCents(129_500, 3)).toBe(388_500);
  });

  test("a rate rounds to whole cents", () => {
    expect(scaleCents(3333, 0.15)).toBe(500); // 499.95 -> 500
  });

  test("rounds half away from zero, both directions", () => {
    expect(scaleCents(1, 0.5)).toBe(1);
    expect(scaleCents(-1, 0.5)).toBe(-1);
  });
});

describe("sumCents", () => {
  test("sums within one currency", () => {
    expect(
      sumCents(
        [
          { amountCents: 950_000, currency: "ZAR" },
          { amountCents: 110_000, currency: "ZAR" },
        ],
        "ZAR",
      ),
    ).toBe(1_060_000);
  });

  test("REFUSES to sum across currencies", () => {
    expect(() =>
      sumCents(
        [
          { amountCents: 950_000, currency: "ZAR" },
          { amountCents: 50_000, currency: "USD" },
        ],
        "ZAR",
      ),
    ).toThrow(/refusing to sum USD into a ZAR total/);
  });

  test("an empty set is zero, not an error", () => {
    expect(sumCents([], "ZAR")).toBe(0);
  });
});

describe("formatCents", () => {
  test("formats ZAR in en-ZA", () => {
    // Non-breaking spaces vary by ICU build; assert the parts that matter.
    const out = formatCents(129_500, "ZAR");
    expect(out).toContain("1");
    expect(out).toContain("295,00");
  });
});
