import type { AccentRamp } from "../accent";
import type { SiteConfig } from "../site-config";
import { SITE_CONFIG_VERSION } from "../site-config";
import type { Section } from "../sections";

/**
 * A CONFIG FOR A CLIENT WHOSE WEBSITE IS NOT OURS.
 *
 * The back office needs a `sites` row and this is the smallest honest one.
 * Not a niche template and not a skin — it composes no page, because there
 * is no page to compose: the client's site is built and hosted elsewhere and
 * `apps/sites` will never render this.
 *
 * WHY A SITE ROW AT ALL, given we do not serve the site. `public/quote.ts`
 * resolves slug -> site -> `site.clientId`, and it takes three things from
 * the config rather than from the browser: which fields exist, which are
 * required, and the exact notice stored with the submission. That is the
 * server owning the shape of the form, which is the property worth keeping
 * whoever renders the markup. Without a site row there is no tenant to
 * attribute an enquiry to and no declaration to validate it against.
 *
 * IT IS NEVER PUBLICLY SERVED, and that is structural rather than a setting.
 * `insertSite` is called with `publish: false`, so `publishedConfig` is
 * absent — and `public/site.ts` returns a holding page when it is absent,
 * while `public/quote.ts` falls back to `config`. So the same row that
 * declares the form cannot become a second, wrong version of the client's
 * website sitting at a guessable URL. No new status, no new flag: the
 * existing draft/published split already meant exactly this.
 */

export type EnquiryField = Extract<Section, { type: "quote" }>["fields"][number];

export type EnquiryOnlyInput = {
  businessName: string;
  slug: string;
  brandColour: string;
  accent: AccentRamp;
  currency: SiteConfig["currency"];
  /** Where the real site lives. Recorded, never fetched. */
  externalSiteUrl?: string;
  locations: Array<{
    id: string;
    name: string;
    suburb: string;
    city: string;
    region: string;
    countryCode?: string;
    timezone?: string;
    addressLine?: string;
    phone?: string;
    email?: string;
  }>;
  enquiry: {
    heading: string;
    fields: EnquiryField[];
    noticeText: string;
    marketingConsentText?: string;
    submitLabel?: string;
    successMessage?: string;
  };
};

export function enquiryOnlyConfig(input: EnquiryOnlyInput): SiteConfig {
  const timezone = input.locations[0]?.timezone ?? "Africa/Johannesburg";

  return {
    version: SITE_CONFIG_VERSION,
    /*
     * Named for what it is. A future reader looking for the ski template will
     * not find one, and should not: this composes no page.
     */
    template: "enquiry-only",
    variant: "default",
    currency: input.currency,
    defaultTimezone: timezone,

    brand: {
      name: input.businessName,
      colour: input.brandColour,
      accent: input.accent,
      typeScale: "regular",
      fontPair: "inter-inter",
    },

    locations: input.locations.map((location) => ({
      id: location.id,
      name: location.name,
      /*
       * `addressLine` stays optional here for the same reason it is optional
       * in the schema: a business that publishes a suburb and no street has
       * told us a suburb, and inventing the rest would print an address they
       * never gave under their own name.
       */
      addressLine: location.addressLine,
      suburb: location.suburb,
      city: location.city,
      region: location.region,
      countryCode: location.countryCode ?? "ZA",
      timezone: location.timezone ?? timezone,
      phone: location.phone,
      email: location.email,
      hours: [],
    })),

    sections: [
      {
        id: "enquiry",
        type: "quote",
        variant: "default",
        hidden: false,
        heading: input.enquiry.heading,
        fields: input.enquiry.fields,
        /*
         * Photo upload off. It writes to Convex storage from a public
         * mutation, and turning it on for a form we do not render would open
         * an upload path nothing on the client's site is asking for.
         */
        photoUpload: { enabled: false, maxFiles: 1 },
        noticeText: input.enquiry.noticeText,
        marketingConsent: input.enquiry.marketingConsentText
          ? { text: input.enquiry.marketingConsentText }
          : undefined,
        submitLabel: input.enquiry.submitLabel ?? "Send enquiry",
        successMessage:
          input.enquiry.successMessage ??
          "Thank you — we have your enquiry and will be in touch.",
      },
    ],

    seo: {
      /*
       * Never rendered, so this is a label rather than a page title. It is
       * still required, and a placeholder here would be a placeholder on a
       * document nobody checks.
       */
      title: `${input.businessName} — enquiries`,
      description:
        `Enquiry handling for ${input.businessName}. This record exists so enquiries ` +
        `reach their back office; their website is published elsewhere.`,
      /*
       * BELT AND BRACES. The row is never served — there is no
       * `publishedConfig` — so nothing can index it. Set anyway, because a
       * future publish of this row by mistake should not also be indexable.
       */
      noindex: true,
      canonicalHost: input.externalSiteUrl,
    },

    features: {
      /*
       * QUOTES ON, BOOKING OFF, and both are load-bearing. `siteConfig`
       * refuses a quote section while `features.quotes` is false, and a
       * booking feature left on would offer a calendar to a business that
       * sells no appointments.
       */
      booking: false,
      quotes: true,
      gallery: false,
      reviews: false,
      stock: false,
      analytics: { consentGated: true },
    },

    legal: {},
  };
}
