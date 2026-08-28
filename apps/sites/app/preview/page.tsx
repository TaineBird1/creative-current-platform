import { buildAccentRamp, parseSiteConfig, solarTradesTemplate } from "@cc/site-config";
import { SiteRenderer } from "@/components/SiteRenderer";

/**
 * Variant preview. Renders template #1 straight from the seed with no backend,
 * so a skin can be reviewed on a real phone before any client exists — and so
 * the accent ramp can be checked against a real brand colour rather than a
 * swatch. `?brand=` accepts any 6-digit hex.
 *
 * The config goes through parseSiteConfig, exactly as a stored one does. A
 * preview that skipped validation would be a second compose pipeline, and the
 * whole point is that there is only one.
 */
export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  const { brand } = await searchParams;
  const colour = /^#[0-9a-fA-F]{6}$/.test(brand ?? "") ? brand! : "#f26a1b";

  const config = parseSiteConfig(
    solarTradesTemplate({
      businessName: "Renu Solar",
      slug: "renu-solar",
      brandColour: colour,
      accent: buildAccentRamp(colour),
      city: "Durban",
      region: "KwaZulu-Natal",
      suburb: "Hillcrest",
      addressLine: "12 Old Main Road",
      phone: "+27315551234",
      whatsapp: "+27825551234",
      email: "hello@renusolar.co.za",
    }),
  );

  return <SiteRenderer config={config} slug="renu-solar" preview />;
}
