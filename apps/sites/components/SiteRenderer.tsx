import type { SiteConfig } from "@cc/site-config";
import { buildAccentRamp } from "@cc/site-config";
import { accentStyle } from "@/lib/accent-css";
import {
  Columns,
  Contact,
  Faq,
  Hero,
  LogoStrip,
  Narrative,
  Process,
  StatBand,
  StickyBar,
} from "./sections/Blocks";
import { QuoteForm } from "./sections/QuoteForm";

/**
 * THE RENDERER. One of these serves every tenant.
 *
 * It knows nothing about which client it is drawing: the accent arrives as
 * CSS custom properties and the content arrives as a validated SiteConfig.
 * That is what makes "client sites are data, not code" true rather than
 * aspirational — a fix here ships to every client at once.
 *
 * An unknown section type renders NOTHING rather than throwing. A config
 * written by a newer deploy must degrade, never blank the page.
 */
export function SiteRenderer({
  config,
  slug,
  onQuoteSubmit,
}: {
  config: SiteConfig;
  slug: string;
  onQuoteSubmit?: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const ramp = config.brand.accent ?? buildAccentRamp(config.brand.colour);
  const visible = config.sections.filter((section) => !section.hidden);
  const sticky = visible.find((section) => section.type === "stickyBar");

  return (
    <div className="world-client" style={accentStyle(ramp)}>
      <a className="sr-only" href="#main">
        Skip to content
      </a>
      <main id="main">
        {visible.map((section) => {
          switch (section.type) {
            case "hero":
              return <Hero key={section.id} section={section} config={config} />;
            case "statBand":
              return <StatBand key={section.id} section={section} />;
            case "narrative":
              return <Narrative key={section.id} section={section} />;
            case "process":
              return <Process key={section.id} section={section} />;
            case "cards":
              return <Columns key={section.id} section={section} />;
            case "logoStrip":
              return <LogoStrip key={section.id} section={section} />;
            case "faq":
              return <Faq key={section.id} section={section} />;
            case "quote":
              return (
                <QuoteForm
                  key={section.id}
                  section={section}
                  slug={slug}
                  onSubmit={onQuoteSubmit}
                />
              );
            case "contact":
              return <Contact key={section.id} section={section} config={config} />;
            default:
              // stickyBar renders outside <main>; anything unknown is skipped.
              return null;
          }
        })}
      </main>
      {sticky?.type === "stickyBar" ? (
        <StickyBar section={sticky} config={config} />
      ) : null}
    </div>
  );
}
