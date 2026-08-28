// @vitest-environment node
import { describe, expect, test } from "vitest";
import { buildAccentRamp } from "./accent";
import { contrastRatio } from "./primitives";
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

describe("accent ramp", () => {
  const brands = [
    "#1f6f43", // forest
    "#ffd400", // a yellow that CANNOT pass on white without correction
    "#000000",
    "#ffffff",
    "#7d7d7d", // near-grey
    "#e2001a", // a loud red
    "#00b3ff", // a light cyan
  ];

  test.each(brands)("%s produces an AA-safe ramp", (brand) => {
    const ramp = buildAccentRamp(brand);
    expect(contrastRatio(ramp[700], "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ramp[500], ramp.onAccent)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(brands)("%s yields a config that parses", (brand) => {
    const result = safeParseSiteConfig(seed(brand));
    expect(result.success).toBe(true);
  });
});
