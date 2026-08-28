import { z } from "zod";
import { configMoney, image, workImage, key, phone, slug } from "./primitives";

/**
 * THE SECTION REGISTRY.
 *
 * Every section is: a `type` discriminator + a Zod schema. The renderer maps
 * type -> component; the editor maps type -> form; the demo generator maps
 * type -> default-content generator. Adding a client capability means adding
 * a member here, never forking a client's code.
 *
 * `variant` is the layout skin. Registered per type in the renderer; unknown
 * variants fall back to the first registered one rather than erroring, so a
 * bad variant never blanks a live site.
 */

const base = {
  id: slug,
  variant: z.string().min(1).default("default"),
  hidden: z.boolean().default(false),
  anchor: slug.optional(),
};

export const heroSection = z.object({
  ...base,
  type: z.literal("hero"),
  headline: z.string().min(1).max(90),
  subhead: z.string().max(220).optional(),
  media: image.optional(),
  primaryCta: z.object({ label: z.string().min(1), action: z.enum(["book", "quote", "call", "whatsapp", "link"]), href: z.string().optional() }),
  secondaryCta: z.object({ label: z.string().min(1), action: z.enum(["book", "quote", "call", "whatsapp", "link"]), href: z.string().optional() }).optional(),
  trustLine: z.string().max(120).optional(),
});

export const servicesSection = z.object({
  ...base,
  type: z.literal("services"),
  heading: z.string().min(1),
  items: z.array(
    z.object({
      serviceKey: key,
      name: z.string().min(1),
      description: z.string().max(400).optional(),
      /** Absent price + quoteRequired:true routes to the quote flow instead of booking. */
      price: configMoney.optional(),
      priceIsFrom: z.boolean().default(false),
      /** Demo sites price at typical rates — this flag renders the disclaimer. */
      priceIsIllustrative: z.boolean().default(false),
      quoteRequired: z.boolean().default(false),
      bookable: z.boolean().default(true),
      media: image.optional(),
    }),
  ).min(1),
});

export const bookingSection = z.object({
  ...base,
  type: z.literal("booking"),
  heading: z.string().min(1),
  /** Zero-friction: name + phone only, no end-customer account, ever. */
  collect: z.object({ email: z.boolean().default(false), address: z.boolean().default(false), notes: z.boolean().default(true) }),
  leadWithNextAvailable: z.literal(true),
  locationIds: z.array(slug).optional(),
});

export const quoteSection = z.object({
  ...base,
  type: z.literal("quote"),
  heading: z.string().min(1),
  fields: z.array(z.object({ key, label: z.string().min(1), kind: z.enum(["text", "longtext", "number", "select", "photos"]), required: z.boolean().default(false), options: z.array(z.string()).optional() })).min(1),
  photoUpload: z.object({ enabled: z.boolean().default(true), maxFiles: z.number().int().min(1).max(10).default(5) }),
  /** POPIA: the exact words the customer agreed to, stored with the submission. */
  consentText: z.string().min(20),
  submitLabel: z.string().min(1).default("Request a quote"),
  /** Shown after submission. No redirect, no account, no "check your email". */
  successMessage: z.string().min(1).default("Got it. We will call you back."),
});

export const gallerySection = z.object({
  ...base,
  type: z.literal("gallery"),
  heading: z.string().min(1),
  /** Real work only. workImage rejects stock/AI/scraped and unconsented assets. */
  items: z.array(z.object({ media: workImage, caption: z.string().max(160).optional(), locationId: slug.optional() })).min(1),
});

export const teamSection = z.object({
  ...base,
  type: z.literal("team"),
  heading: z.string().min(1),
  members: z.array(z.object({ name: z.string().min(1), role: z.string().min(1), photo: image.optional(), bio: z.string().max(400).optional() })).min(1),
});

export const serviceAreaSection = z.object({
  ...base,
  type: z.literal("serviceAreas"),
  heading: z.string().min(1),
  /** Each area generates a landing page carrying LocalBusiness schema — the local-SEO play. */
  areas: z.array(z.object({
    slug,
    name: z.string().min(1),
    locationId: slug,
    intro: z.string().max(600).optional(),
    generatePage: z.boolean().default(true),
  })).min(1),
});

export const certificationsSection = z.object({
  ...base,
  type: z.literal("certifications"),
  items: z.array(z.object({ name: z.string().min(1), logo: image.optional(), reference: z.string().optional() })).min(1),
});

export const reviewsSection = z.object({
  ...base,
  type: z.literal("reviews"),
  heading: z.string().min(1),
  /** Live Google reviews by Place ID. Review-gating is banned platform-wide. */
  placeId: z.string().min(1),
  minRating: z.literal(1).describe("filtering reviews by rating is review-gating; pinned to 1"),
  maxItems: z.number().int().min(1).max(12).default(6),
});

export const faqSection = z.object({
  ...base,
  type: z.literal("faq"),
  heading: z.string().min(1),
  items: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).min(1),
});

export const aboutSection = z.object({
  ...base,
  type: z.literal("about"),
  heading: z.string().min(1),
  body: z.string().min(1),
  media: image.optional(),
});

export const contactSection = z.object({
  ...base,
  type: z.literal("contact"),
  heading: z.string().min(1),
  showMap: z.boolean().default(true),
  /** POPIA: explicit consent copy + lawful basis recorded with every submission. */
  consent: z.object({ required: z.literal(true), text: z.string().min(20), lawfulBasis: z.enum(["consent", "contract", "legitimate_interest"]) }),
});

export const stickyBarSection = z.object({
  ...base,
  type: z.literal("stickyBar"),
  actions: z.array(z.enum(["book", "quote", "call", "whatsapp"])).min(1).max(3),
  phone: phone.optional(),
  whatsapp: phone.optional(),
});

/**
 * Editorial prose. The section that carries an argument rather than a list.
 * Added for the solar template, where the case for buying is the content.
 */
export const narrativeSection = z.object({
  ...base,
  type: z.literal("narrative"),
  eyebrow: z.string().max(60).optional(),
  heading: z.string().min(1),
  body: z.array(z.string().min(1)).min(1),
  pullQuote: z.string().max(240).optional(),
  media: image.optional(),
  tone: z.enum(["default", "dark", "paper", "accent"]).default("default"),
});

/** Numbered steps with optional day markers and an owner per step. */
export const processSection = z.object({
  ...base,
  type: z.literal("process"),
  eyebrow: z.string().max(60).optional(),
  heading: z.string().min(1),
  intro: z.string().max(400).optional(),
  steps: z.array(z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    marker: z.string().max(24).optional(),
    owner: z.string().max(60).optional(),
  })).min(2).max(12),
});

/** Titled card grid. Covers sectors, promises, differentiators, guarantees. */
export const cardsSection = z.object({
  ...base,
  type: z.literal("cards"),
  eyebrow: z.string().max(60).optional(),
  heading: z.string().min(1),
  intro: z.string().max(400).optional(),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  items: z.array(z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    media: image.optional(),
    href: z.string().optional(),
  })).min(2),
});

/** Equipment, partners, accreditations. Logos only, no claims attached. */
export const logoStripSection = z.object({
  ...base,
  type: z.literal("logoStrip"),
  eyebrow: z.string().max(60).optional(),
  intro: z.string().max(400).optional(),
  logos: z.array(z.object({ name: z.string().min(1), media: image.optional() })).min(2),
  /** Renders the "we are not tied to one manufacturer" disclaimer. */
  disclaimer: z.string().max(240).optional(),
});

/** One number that carries the argument, with its source stated. */
export const statBandSection = z.object({
  ...base,
  type: z.literal("statBand"),
  stats: z.array(z.object({
    value: z.string().min(1),
    label: z.string().min(1),
    /** A number without a source is a claim. Required, not optional. */
    source: z.string().min(1),
    asAt: z.string().max(40).optional(),
  })).min(1).max(4),
});

/** Closing call to action. */
export const ctaSection = z.object({
  ...base,
  type: z.literal("cta"),
  heading: z.string().min(1),
  body: z.string().max(400).optional(),
  primaryCta: z.object({ label: z.string().min(1), action: z.enum(["book", "quote", "call", "whatsapp", "link"]), href: z.string().optional() }),
  secondaryCta: z.object({ label: z.string().min(1), action: z.enum(["book", "quote", "call", "whatsapp", "link"]), href: z.string().optional() }).optional(),
});

export const section = z.discriminatedUnion("type", [
  heroSection, servicesSection, bookingSection, quoteSection, gallerySection,
  teamSection, serviceAreaSection, certificationsSection, reviewsSection,
  faqSection, aboutSection, contactSection, stickyBarSection,
  narrativeSection, processSection, cardsSection, logoStripSection,
  statBandSection, ctaSection,
]);

export type Section = z.infer<typeof section>;
export type SectionType = Section["type"];

export const SECTION_TYPES = [
  "hero", "services", "booking", "quote", "gallery", "team", "serviceAreas",
  "certifications", "reviews", "faq", "about", "contact", "stickyBar",
  "narrative", "process", "cards", "logoStrip", "statBand", "cta",
] as const satisfies readonly SectionType[];
