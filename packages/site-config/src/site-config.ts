import { z } from "zod";
import { accentRamp, currency, hexColour, image, phone, slug, timezone } from "./primitives";
import { section } from "./sections";

export const SITE_CONFIG_VERSION = 1;

export const brand = z.object({
  name: z.string().min(1),
  legalName: z.string().optional(),
  logo: image.optional(),
  colour: hexColour,
  /** Derived from `colour`, never hand-authored. Rejected if it fails AA. */
  accent: accentRamp,
  typeScale: z.enum(["compact", "regular", "generous"]).default("regular"),
  fontPair: z.enum(["inter-inter", "fraunces-inter", "sora-inter", "instrument-inter"]).default("inter-inter"),
});

export const siteLocation = z.object({
  id: slug,
  name: z.string().min(1),
  addressLine: z.string().min(1),
  suburb: z.string().min(1),
  city: z.string().min(1),
  region: z.string().min(1),
  postalCode: z.string().optional(),
  countryCode: z.string().length(2),
  geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
  placeId: z.string().optional(),
  phone: phone.optional(),
  whatsapp: phone.optional(),
  email: z.string().email().optional(),
  /** Stored per site regardless of the Africa/Johannesburg default. */
  timezone,
  hours: z.array(z.object({
    day: z.number().int().min(0).max(6),
    open: z.string().regex(/^\d{2}:\d{2}$/),
    close: z.string().regex(/^\d{2}:\d{2}$/),
  })).default([]),
});

export const seo = z.object({
  title: z.string().min(1).max(70),
  description: z.string().min(1).max(180),
  ogImage: image.optional(),
  noindex: z.boolean().default(false),
  canonicalHost: z.string().optional(),
});

export const features = z.object({
  booking: z.boolean().default(true),
  quotes: z.boolean().default(false),
  gallery: z.boolean().default(true),
  reviews: z.boolean().default(true),
  stock: z.boolean().default(false),
  /** Analytics are opt-in per tenant and consent-gated at runtime. */
  analytics: z.object({
    ga4MeasurementId: z.string().optional(),
    metaPixelId: z.string().optional(),
    consentGated: z.literal(true),
  }).default({ consentGated: true }),
});

export const siteConfig = z
  .object({
    version: z.literal(SITE_CONFIG_VERSION),
    template: slug.describe("niche template, e.g. 'guest-house'. Composes from the shared registry."),
    variant: slug.describe("skin within the template"),
    brand,
    locations: z.array(siteLocation).min(1),
    sections: z.array(section).min(1),
    seo,
    features,
    currency,
    defaultTimezone: timezone,
    legal: z.object({
      privacyUrl: z.string().optional(),
      termsUrl: z.string().optional(),
      /** POPIA information-officer contact. Required before go-live. */
      informationOfficerEmail: z.string().email().optional(),
    }).default({}),
  })
  .superRefine((cfg, ctx) => {
    const ids = cfg.sections.map((s) => s.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: "section ids must be unique" });
    }
    const locationIds = new Set(cfg.locations.map((l) => l.id));
    for (const [i, s] of cfg.sections.entries()) {
      if (s.type === "serviceAreas") {
        for (const a of s.areas) {
          if (!locationIds.has(a.locationId)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", i], message: `serviceArea '${a.slug}' points at unknown location '${a.locationId}'` });
          }
        }
      }
      if (s.type === "booking" && !cfg.features.booking) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", i], message: "booking section present but features.booking is off" });
      }
      if (s.type === "quote" && !cfg.features.quotes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", i], message: "quote section present but features.quotes is off" });
      }
    }
  });

export type SiteConfig = z.infer<typeof siteConfig>;

/**
 * The ONLY way a config enters the database. Demo generation and real
 * onboarding both call this — one compose pipeline, no second path.
 */
export function parseSiteConfig(input: unknown): SiteConfig {
  return siteConfig.parse(input);
}

export function safeParseSiteConfig(input: unknown) {
  return siteConfig.safeParse(input);
}
