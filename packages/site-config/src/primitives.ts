import { z } from "zod";

/** ISO-4217. Closed union so "never sum currencies" is checkable at the type level. */
export const currency = z.enum(["ZAR", "USD", "EUR", "GBP", "NAD", "BWP"]);
export type Currency = z.infer<typeof currency>;

/**
 * Money inside SiteConfig only. Config is JSON, so cents are a validated
 * integer `number` here. Financial RECORDS (invoices, ledger) use int64 —
 * see convex/tables/money.ts. The two never mix.
 */
export const configMoney = z.object({
  amountCents: z.number().int().nonnegative(),
  currency,
});

export const hexColour = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "brand colour must be a 6-digit hex");

/* ------------------------------------------------------------------ *
 * Contrast — the AA gate on the accent ramp lives in the schema, not
 * in a designer's head. An invalid ramp cannot be persisted.
 * ------------------------------------------------------------------ */

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  // Every channel must be linearised. Missing channel() on any one of them
  // inflates luminance by up to ~18x and makes the whole AA gate a no-op --
  // silently, because both sides of the comparison use the same function.
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Accent ramp derived from the client's brand colour. Steps 50..900.
 * `onAccent` is the text colour used on top of step 500 — it must clear
 * AA 4.5:1 or the config is rejected.
 */
/**
 * The DARKEST light ground an accent ever sits on: the sunken band (ink-50).
 * Correcting against #ffffff instead was a real bug -- a ramp that cleared
 * 4.5:1 on pure white measured 4.40:1 on the page's actual warm ground, so
 * the gate passed and the rendered page failed. Validate against the surface
 * you actually paint, not the one that flatters the number.
 */
export const SURFACE_FLOOR = "#f7f7f6";

export const accentRamp = z
  .object({
    50: hexColour,
    100: hexColour,
    200: hexColour,
    300: hexColour,
    400: hexColour,
    500: hexColour,
    600: hexColour,
    700: hexColour,
    800: hexColour,
    900: hexColour,
    onAccent: hexColour,
  })
  .superRefine((ramp, ctx) => {
    const body = contrastRatio(ramp[700], SURFACE_FLOOR);
    if (body < 4.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `accent.700 on the page ground is ${body.toFixed(2)}:1, needs >= 4.5:1`,
      });
    }
    // The tinted band uses step 50 as its ground and step 700 as its text.
    const onTint = contrastRatio(ramp[700], ramp[50]);
    if (onTint < 4.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `accent.700 on accent.50 is ${onTint.toFixed(2)}:1, needs >= 4.5:1`,
      });
    }
    const button = contrastRatio(ramp[500], ramp.onAccent);
    if (button < 4.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `onAccent on accent.500 is ${button.toFixed(2)}:1, needs >= 4.5:1`,
      });
    }
  });

/* ------------------------------------------------------------------ *
 * Imagery provenance — Part 6. Stock/AI/scraped may never appear as the
 * client's real work, and every asset carries a recall switch.
 * ------------------------------------------------------------------ */

export const provenance = z.enum(["client", "stock", "ai", "scraped"]);

export const image = z.object({
  storageId: z.string().min(1),
  alt: z.string().min(1, "alt text is required"),
  provenance,
  /** Client's written consent to publish this asset. Required for `client`. */
  consent: z.boolean(),
  /** Recall switch: true hides the asset everywhere without deleting it. */
  recalled: z.boolean().default(false),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  focalPoint: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
});
export type Image = z.infer<typeof image>;

/** An image asserting real, delivered work. Only genuine, consented client assets qualify. */
export const workImage = image.refine(
  (i) => i.provenance === "client" && i.consent === true,
  { message: "gallery images must be provenance:'client' with consent:true" },
);

export const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, "phone must be E.164");
export const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/);

/**
 * An identifier used as a RECORD KEY, not in a URL: form field keys, service
 * keys. Distinct from `slug` on purpose -- `propertyType` is a perfectly good
 * field key and a terrible URL segment, and conflating the two rejects valid
 * content for no benefit.
 */
export const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,48}$/, "must be a bare identifier");
export const timezone = z.string().min(3); // IANA, validated against Intl at the boundary
