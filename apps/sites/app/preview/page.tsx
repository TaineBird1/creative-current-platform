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
  searchParams: Promise<{ brand?: string; variant?: string; dates?: string }>;
}) {
  const { brand, variant, dates } = await searchParams;
  const colour = /^#[0-9a-fA-F]{6}$/.test(brand ?? "") ? brand! : "#f26a1b";
  // `?variant=field-manual` to review the other skin. An unknown value falls
  // back rather than erroring, matching how the renderer treats one.
  const skin = variant === "field-manual" ? "field-manual" : "ink";

  /*
   * `?dates=1` ADDS A dateRange FIELD, and it is here because otherwise
   * nobody can look at that control.
   *
   * A solar installer has no use for travel dates, so template #1 rightly
   * does not carry one — which left the only new field kind in the registry
   * unreachable on a phone, and this repo's standing rule is that a screen
   * nobody has tapped is not finished. A native `<input type="date">` is
   * exactly the control that reads fine in source and is wrong in a hand:
   * the picker is the platform's, its width is the platform's, and neither
   * is visible from the JSX.
   *
   * Injected AFTER the template and BEFORE `parseSiteConfig`, so it goes
   * through the same validation a stored config does rather than becoming a
   * second compose path.
   */
  const withDates = (cfg: ReturnType<typeof solarTradesTemplate>) =>
    dates !== "1"
      ? cfg
      : {
          ...cfg,
          sections: cfg.sections.map((section) =>
            section.type === "quote"
              ? {
                  ...section,
                  fields: [
                    ...section.fields,
                    {
                      key: "travelDates",
                      label: "When are you going?",
                      kind: "dateRange" as const,
                      required: true,
                    },
                  ],
                }
              : section,
          ),
        };

  const config = parseSiteConfig(
    withDates(solarTradesTemplate({
      businessName: "Renu Solar",
      slug: "renu-solar",
      brandColour: colour,
      variant: skin,
      accent: buildAccentRamp(colour),
      city: "Durban",
      region: "KwaZulu-Natal",
      suburb: "Hillcrest",
      addressLine: "12 Old Main Road",
      phone: "+27315551234",
      whatsapp: "+27825551234",
      email: "hello@renusolar.co.za",
    })),
  );

  // A variant preview of our OWN template, not a demo of anyone's business.
  return <SiteRenderer config={config} slug="renu-solar" preview isDemo={false} demo={null} />;
}
