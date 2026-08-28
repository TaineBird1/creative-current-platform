// @vitest-environment node
import { describe, expect, test } from "vitest";
import { anchorStep, buildAccentRamp, RAMP_STEPS } from "./accent";
import { contrastRatio, relativeLuminance, SURFACE_FLOOR } from "./primitives";
import { safeParseSiteConfig, parseSiteConfig } from "./site-config";
import { solarTradesTemplate } from "./templates/solar-trades";
import { SECTION_TYPES } from "./sections";

/**
 * The registry is only real if real content passes through it. Template #1 is
 * seeded from a shipped solar site, so these tests are the registry being
 * exercised by content nobody invented to fit it.
 */

const seed = (brandColour = "#1f6f43") =>
  solarTradesTemplate({
    businessName: "Renu Solar",
    slug: "renu-solar",
    brandColour,
    accent: buildAccentRamp(brandColour),
    city: "Durban",
    region: "KwaZulu-Natal",
    suburb: "Hillcrest",
    addressLine: "12 Old Main Road",
    phone: "+27315551234",
    whatsapp: "+27825551234",
    email: "hello@example.co.za",
  });

describe("template #1 (solar/trades)", () => {
  test("parses against the registry", () => {
    const result = safeParseSiteConfig(seed());
    if (!result.success) {
      throw new Error(
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
      );
    }
    expect(result.success).toBe(true);
  });

  test("uses the quote flow, not booking", () => {
    const cfg = parseSiteConfig(seed());
    expect(cfg.features.booking).toBe(false);
    expect(cfg.sections.some((s) => s.type === "booking")).toBe(false);
    expect(cfg.sections.some((s) => s.type === "quote")).toBe(true);
  });

  test("ships no gallery and no reviews -- assets we do not have at seed time", () => {
    const cfg = parseSiteConfig(seed());
    expect(cfg.sections.some((s) => s.type === "gallery")).toBe(false);
    expect(cfg.sections.some((s) => s.type === "reviews")).toBe(false);
  });

  test("every stat carries a source", () => {
    const cfg = parseSiteConfig(seed());
    for (const s of cfg.sections) {
      if (s.type !== "statBand") continue;
      for (const stat of s.stats) expect(stat.source.length).toBeGreaterThan(0);
    }
  });

  test("section ids are unique", () => {
    const cfg = parseSiteConfig(seed());
    const ids = cfg.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("registry invariants", () => {
  test("a booking section is rejected when features.booking is off", () => {
    const cfg = seed();
    cfg.sections.push({
      id: "book", type: "booking", variant: "default", hidden: false,
      heading: "Book", leadWithNextAvailable: true,
      collect: { email: false, address: false, notes: true },
    });
    const result = safeParseSiteConfig(cfg);
    expect(result.success).toBe(false);
  });

  test("a gallery refuses stock imagery presented as real work", () => {
    const cfg = seed();
    cfg.features.gallery = true;
    cfg.sections.push({
      id: "work", type: "gallery", variant: "default", hidden: false,
      heading: "Our work",
      items: [{
        media: {
          storageId: "kg123", alt: "A solar array", provenance: "stock",
          consent: true, recalled: false,
        },
      }],
    });
    const result = safeParseSiteConfig(cfg);
    expect(result.success).toBe(false);
  });

  test("a service area pointing at an unknown location is rejected", () => {
    const cfg = seed();
    cfg.sections.push({
      id: "areas", type: "serviceAreas", variant: "default", hidden: false,
      heading: "Where we work",
      areas: [{ slug: "ballito", name: "Ballito", locationId: "nowhere", generatePage: true }],
    });
    const result = safeParseSiteConfig(cfg);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("nowhere");
  });

  test("the registry declares every section type it implements", () => {
    expect(SECTION_TYPES).toHaveLength(19);
    expect(new Set(SECTION_TYPES).size).toBe(SECTION_TYPES.length);
  });
});

describe("contrast maths", () => {
  // Pinned against published WCAG values. The first version of
  // relativeLuminance failed to linearise the BLUE channel, which inflated
  // luminance by up to ~18x -- and every test passed anyway, because both
  // sides of the comparison used the same broken function. These are the
  // numbers that would have caught it.
  test.each([
    ["#000000", "#ffffff", 21],
    ["#ffffff", "#ffffff", 1],
    ["#777777", "#ffffff", 4.48],
    ["#0000ff", "#ffffff", 8.59], // blue: the channel that was wrong
    ["#00ff00", "#ffffff", 1.37],
    ["#ff0000", "#ffffff", 3.998],
    // Only published reference values belong here. A number derived from our
    // own output would assert the code against itself and pin nothing.
  ])("contrast(%s, %s) is about %s", (a, b, expected) => {
    expect(contrastRatio(a, b)).toBeCloseTo(expected, 1);
  });

  test("is symmetric", () => {
    expect(contrastRatio("#12305e", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#12305e"), 10,
    );
  });
});

describe("accent ramp", () => {
  const brands = [
    "#1f6f43", // forest
    "#f26a1b", // solar orange -- a real client colour for template #1
    "#12305e", // deep navy   -- the other real client colour
    "#ffd400", // a yellow that CANNOT pass on white without correction
    "#000000",
    "#ffffff",
    "#7d7d7d", // near-grey
    "#e2001a", // a loud red
    "#00b3ff", // a light cyan
  ];

  test.each(brands)("%s produces a monotonic ramp", (brand) => {
    const ramp = buildAccentRamp(brand);
    // A correction that pushes 700 past 800 produces a ramp that looks broken
    // in a way no contrast check catches. This is that check.
    const lum = RAMP_STEPS.map((s) => relativeLuminance(ramp[s]));
    for (let i = 1; i < lum.length; i++) {
      expect(lum[i]!, `step ${RAMP_STEPS[i]} must be darker than ${RAMP_STEPS[i - 1]}`)
        .toBeLessThan(lum[i - 1]!);
    }
  });

  test.each(brands)("%s keeps the client's own colour in the ramp", (brand) => {
    // A navy client whose accent comes out a generic mid-blue has been given
    // somebody else's brand.
    const ramp = buildAccentRamp(brand);
    const step = anchorStep(brand);
    const drift = contrastRatio(ramp[step], brand);
    expect(drift, `${brand} drifted to ${ramp[step]} at step ${step}`).toBeLessThan(1.45);
  });

  test.each(brands)("%s produces an AA-safe ramp on every ground it lands on", (brand) => {
    const ramp = buildAccentRamp(brand);
    // Against the DARKEST light band, not pure white. Measuring on white
    // flattered the number by ~0.15 and shipped two brands at 4.40:1.
    expect(contrastRatio(ramp[700], SURFACE_FLOOR)).toBeGreaterThanOrEqual(4.5);
    // The tinted band paints 50 and writes 700 on it.
    expect(contrastRatio(ramp[700], ramp[50])).toBeGreaterThanOrEqual(4.5);
    // The button fill under whichever foreground it was given.
    expect(contrastRatio(ramp[500], ramp.onAccent)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(brands)("%s yields a config that parses", (brand) => {
    const result = safeParseSiteConfig(seed(brand));
    expect(result.success).toBe(true);
  });
});
