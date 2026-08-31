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
  preview = false,
}: {
  config: SiteConfig;
  slug: string;
  onQuoteSubmit?: (payload: Record<string, unknown>) => Promise<void>;
  /** Variant preview: the quote form says nothing was recorded. */
  preview?: boolean;
}) {
  const ramp = config.brand.accent ?? buildAccentRamp(config.brand.colour);
  const visible = config.sections.filter((section) => !section.hidden);
  const sticky = visible.find((section) => section.type === "stickyBar");

  return (
    /*
     * `data-variant` is the ONLY thing a skin gets. Variant styling is CSS
     * scoped to this attribute — never a second component tree, never a
     * branch in this file. A client site is data, so a skin is a stylesheet,
     * and an unknown variant simply inherits the base look rather than
     * blanking the page.
     */
    <div
      className="world-client"
      data-variant={config.variant}
      style={accentStyle(ramp)}
    >
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
                  preview={preview}
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
