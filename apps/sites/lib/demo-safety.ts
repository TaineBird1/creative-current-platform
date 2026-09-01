import type { SiteConfig } from "@cc/site-config";

/**
 * EVERYTHING A DEMO MUST NOT ASSERT, IN ONE PLACE.
 *
 * A demo carries a real business's name, their suburb and their real Google
 * rating. `noindex` keeps it out of search results and does nothing else —
 * and the three things below all sit outside what `noindex` governs:
 *
 *   A LINK PREVIEW. Sending the demo over WhatsApp is the intended flow, so
 *   the scraped card is the FIRST thing the prospect sees, before the page
 *   and before the disclosure bar. Scrapers do not honour noindex; they read
 *   the OG tags and show them. A card reading "Upper Highway Solar — Solar
 *   installation in Hillcrest" forwarded into a family group chat is the
 *   business's own website as far as every reader is concerned.
 *
 *   STRUCTURED DATA. `LocalBusiness` markup is a machine-readable assertion
 *   that a business of this name trades at this address on these hours. On a
 *   demo it is a claim we are not entitled to make, in the one format built
 *   to be believed without a human reading it.
 *
 *   A FORM RESPONSE. Covered in the quote flow rather than here, but the same
 *   shape: silence reads as success.
 *
 * All of it is decided here and applied by the route and the renderer, so a
 * template never gets a vote. A per-template rule is one template away from
 * missing, and the template that forgets is a working fake of somebody's
 * business.
 */

export const AGENCY = "The Creative Current";

/**
 * The link-preview card for a demo. Title AND description, because a scraper
 * that gets a corrected title and the business's own marketing description
 * still produces a card that reads as theirs.
 *
 * The framing leads with the word "Proposal" so it survives truncation:
 * WhatsApp shows roughly the first 60 characters of a title, and a
 * disclaimer at the end of a sentence is a disclaimer nobody sees.
 */
export function demoPreviewCard(config: SiteConfig) {
  const subject = config.brand.name;
  return {
    title: `Proposal for ${subject} — by ${AGENCY}`,
    description:
      `A website proposal prepared by ${AGENCY}. This is not ${subject}'s ` +
      `website and we are not affiliated with them. Nothing here is live.`,
  };
}

/**
 * `LocalBusiness` JSON-LD for a real client's site.
 *
 * Returns null for a demo, and that is the whole point of routing it through
 * here: the assertion is not weakened for a demo, it is absent. There is no
 * "demo variant" of this markup, because a correct-looking LocalBusiness
 * record with a caveat in a field nobody parses is still an assertion.
 *
 * Only what the config actually holds is emitted. A guessed openingHours or
 * an invented geo point is a false statement about a real business, and the
 * absence of a field is not a reason to fill it.
 */
export function localBusinessJsonLd(
  config: SiteConfig,
  options: { isDemo: boolean; canonicalUrl?: string },
): string | null {
  if (options.isDemo) return null;

  const location = config.locations[0];
  if (!location) return null;

  const hours = location.hours.map((h) => ({
    "@type": "OpeningHoursSpecification",
    dayOfWeek: DAY_NAMES[h.day],
    opens: h.open,
    closes: h.close,
  }));

  const record: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: config.brand.legalName ?? config.brand.name,
    address: {
      "@type": "PostalAddress",
      streetAddress: location.addressLine,
      addressLocality: location.suburb,
      addressRegion: location.region,
      postalCode: location.postalCode,
      addressCountry: location.countryCode,
    },
  };

  if (options.canonicalUrl) record.url = options.canonicalUrl;
  if (location.phone) record.telephone = location.phone;
  if (location.email) record.email = location.email;
  if (location.geo) {
    record.geo = {
      "@type": "GeoCoordinates",
      latitude: location.geo.lat,
      longitude: location.geo.lng,
    };
  }
  if (hours.length > 0) record.openingHoursSpecification = hours;

  /*
   * There is deliberately no `aggregateRating` here, and it is the field
   * most likely to be added next. A rating on this record would be Google's
   * — 30-day licensed content — restated as our own structured claim, on a
   * page that outlives the licence. See convex/lib/places.ts.
   */
  return JSON.stringify(record);
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
