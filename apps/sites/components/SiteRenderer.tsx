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
import { DemoDisclosure } from "./DemoDisclosure";

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
 *
 * DEMOS ARE ENFORCED HERE AND ONLY HERE.
 *
 * A demo carries a real business's name, their suburb and their real Google
 * rating. Every guarantee that keeps it from being a live impersonation —
 * the disclosure line, the noindex, the expiry — is applied at this one
 * point, because a per-template rule is one template away from missing and
 * the template that forgets is a fake of somebody's business ranking in
 * their own name.
 *
 * `demo` is a REQUIRED prop, not an optional one. Optional would let a new
 * caller omit it and get a bare demo site with no disclosure and no error;
 * required means the compiler asks the question, and passing `null` is a
 * claim that this is not a demo. `isDemo` is passed separately so the two can
 * be cross-checked: a site that says it is a demo and hands over no demo
 * context is a bug, and it throws rather than rendering.
 */
export function SiteRenderer({
  config,
  slug,
  onQuoteSubmit,
  preview = false,
  isDemo,
  demo,
}: {
  config: SiteConfig;
  slug: string;
  onQuoteSubmit?: (payload: Record<string, unknown>) => Promise<void>;
  /** Variant preview: the quote form says nothing was recorded. */
  preview?: boolean;
  /** What the backend says this site is. */
  isDemo: boolean;
  /** Required. `null` is an explicit claim that this is not a demo. */
  demo: { subjectName: string; expiresAt: number } | null;
}) {
  /*
   * FAIL CLOSED. A demo with no context cannot be rendered without its
   * disclosure, so it is not rendered at all. Throwing here surfaces as the
   * error boundary rather than as a page that looks exactly like the
   * business's own site — which is the failure worth refusing to ship.
   */
  if (isDemo && !demo) {
    throw new Error(
      "refusing to render a demo without its disclosure context — a demo carries a real business's name",
    );
  }
  if (isDemo && demo && demo.expiresAt <= Date.now()) {
    throw new Error("refusing to render an expired demo");
  }
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
      {demo ? (
        <DemoDisclosure subjectName={demo.subjectName} expiresAt={demo.expiresAt} />
      ) : null}
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
