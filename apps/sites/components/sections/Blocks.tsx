import type { Section, SiteConfig } from "@cc/site-config";
import s from "./sections.module.css";

/**
 * Presentational blocks for template `solar-trades`, variant `ink`.
 *
 * Three refusals this variant makes on purpose, recorded in DESIGN.md:
 *   - no eyebrow stacked above a heading; `eyebrow` becomes the section's
 *     accessible label instead, so the wayfinding survives without the kicker
 *   - no card grids as page structure; sectors and promises are bordered
 *     editorial columns
 *   - no big-number stat tiles; the tariff figures are a ruled data line with
 *     their sources attached, which is what a tariff notice actually looks like
 */

type Tone = "paper" | "sunken" | "dark" | "accent";

export function Band({
  id,
  tone = "paper",
  label,
  tight,
  children,
}: {
  id: string;
  tone?: Tone;
  label?: string;
  tight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      data-tone={tone}
      className={`band${tight ? " band--tight" : ""}`}
    >
      <div className="shell">{children}</div>
    </section>
  );
}

export function Cta({
  action,
  href,
  label,
  primary,
  phone,
  whatsapp,
}: {
  action: string;
  href?: string;
  label: string;
  primary?: boolean;
  phone?: string;
  whatsapp?: string;
}) {
  return (
    <a
      className={`${s.btn} ${primary ? s.btnPrimary : s.btnSecondary}`}
      href={resolveAction(action, href, phone, whatsapp)}
    >
      {label}
    </a>
  );
}

export function resolveAction(
  action: string,
  href?: string,
  phone?: string,
  whatsapp?: string,
): string {
  switch (action) {
    case "quote":
      return "#quote";
    case "book":
      return "#booking";
    case "call":
      return phone ? `tel:${phone}` : "#contact";
    case "whatsapp":
      return whatsapp ? `https://wa.me/${whatsapp.replace(/\D/g, "")}` : "#contact";
    default:
      return href ?? "#contact";
  }
}

/* ------------------------------------------------------------------ */

export function Hero({
  section,
  config,
}: {
  section: Extract<Section, { type: "hero" }>;
  config: SiteConfig;
}) {
  const loc = config.locations[0];
  return (
    <Band id={section.id} tone="paper">
      <div className={s.hero}>
        <h1 className={s.heroHeadline}>{section.headline}</h1>
        {section.subhead ? <p className={s.heroSub}>{section.subhead}</p> : null}
        <div className={s.heroActions}>
          <Cta
            {...section.primaryCta}
            primary
            phone={loc?.phone}
            whatsapp={loc?.whatsapp}
          />
          {section.secondaryCta ? (
            <Cta {...section.secondaryCta} phone={loc?.phone} whatsapp={loc?.whatsapp} />
          ) : null}
        </div>
        {section.trustLine ? <p className={s.heroTrust}>{section.trustLine}</p> : null}
      </div>
    </Band>
  );
}

export function StatBand({ section }: { section: Extract<Section, { type: "statBand" }> }) {
  return (
    <Band id={section.id} tone="sunken" tight label="Key figures">
      <dl className={s.stats}>
        {section.stats.map((stat) => (
          <div className={s.statRow} key={stat.value + stat.label}>
            <dt className={`${s.statValue} tabular`}>{stat.value}</dt>
            <dd className={s.statLabel}>
              {stat.label}
              <span className={s.statSource}>
                {stat.source}
                {stat.asAt ? ` · ${stat.asAt}` : ""}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </Band>
  );
}

export function Narrative({
  section,
}: {
  section: Extract<Section, { type: "narrative" }>;
}) {
  const tone: Tone = section.tone === "dark" ? "dark" : section.tone === "accent" ? "accent" : "paper";
  return (
    <Band id={section.id} tone={tone} label={section.eyebrow ?? section.heading}>
      <div className={s.narrativeGrid}>
        <h2 className={s.narrativeHeading}>{section.heading}</h2>
        <div>
          <div className={`${s.narrativeBody} prose`}>
            {section.body.map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
          {section.pullQuote ? <p className={s.pullQuote}>{section.pullQuote}</p> : null}
        </div>
      </div>
    </Band>
  );
}

export function Process({ section }: { section: Extract<Section, { type: "process" }> }) {
  return (
    <Band id={section.id} tone="paper" label={section.eyebrow ?? section.heading}>
      <h2 className={s.narrativeHeading}>{section.heading}</h2>
      {section.intro ? <p className="prose">{section.intro}</p> : null}
      <ol className={s.steps}>
        {section.steps.map((step, i) => (
          <li className={s.step} key={step.title}>
            {/* Numbered because the sequence itself is the information. */}
            <span className={`${s.stepMarker} tabular`} aria-hidden="true">
              {step.marker ?? String(i + 1).padStart(2, "0")}
            </span>
            <div>
              <h3 className={s.stepTitle}>{step.title}</h3>
              <p className={s.stepBody}>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Band>
  );
}

export function Columns({
  section,
  tone = "paper",
}: {
  section: Extract<Section, { type: "cards" }>;
  tone?: Tone;
}) {
  return (
    <Band id={section.id} tone={tone} label={section.eyebrow ?? section.heading}>
      <h2 className={s.narrativeHeading}>{section.heading}</h2>
      {section.intro ? <p className="prose">{section.intro}</p> : null}
      <div className={s.columns} data-columns={section.columns}>
        {section.items.map((item) => (
          <div className={s.column} key={item.title}>
            <h3 className={s.columnTitle}>{item.title}</h3>
            <p className={s.columnBody}>{item.body}</p>
          </div>
        ))}
      </div>
    </Band>
  );
}

export function LogoStrip({
  section,
}: {
  section: Extract<Section, { type: "logoStrip" }>;
}) {
  return (
    <Band id={section.id} tone="paper" tight label={section.eyebrow ?? "Equipment"}>
      <div className={s.logos}>
        {section.logos.map((logo) => (
          <span className={s.logoName} key={logo.name}>
            {logo.name}
          </span>
        ))}
      </div>
      {section.disclaimer ? <p className={s.disclaimer}>{section.disclaimer}</p> : null}
    </Band>
  );
}

export function Faq({ section }: { section: Extract<Section, { type: "faq" }> }) {
  return (
    <Band id={section.id} tone="paper" label={section.heading}>
      <h2 className={s.narrativeHeading}>{section.heading}</h2>
      <div className={s.faqList}>
        {section.items.map((item) => (
          <details className={s.faqItem} key={item.q}>
            <summary className={s.faqSummary}>
              {item.q}
              <span className={s.faqMark} aria-hidden="true">
                +
              </span>
            </summary>
            <p className={s.faqAnswer}>{item.a}</p>
          </details>
        ))}
      </div>
    </Band>
  );
}

export function Contact({
  section,
  config,
}: {
  section: Extract<Section, { type: "contact" }>;
  config: SiteConfig;
}) {
  const loc = config.locations[0];
  return (
    <Band id={section.id} tone="sunken" label={section.heading}>
      <h2 className={s.narrativeHeading}>{section.heading}</h2>
      <div className={s.contactGrid}>
        {loc?.phone ? (
          <div>
            <p className={s.contactLabel}>Phone</p>
            <a className={`${s.contactValue} tabular`} href={`tel:${loc.phone}`}>
              {loc.phone}
            </a>
          </div>
        ) : null}
        {loc?.whatsapp ? (
          <div>
            <p className={s.contactLabel}>WhatsApp</p>
            <a
              className={`${s.contactValue} tabular`}
              href={`https://wa.me/${loc.whatsapp.replace(/\D/g, "")}`}
            >
              {loc.whatsapp}
            </a>
          </div>
        ) : null}
        {loc ? (
          <div>
            <p className={s.contactLabel}>Where we are</p>
            <p className={s.contactValue}>
              {[loc.addressLine, loc.suburb, loc.city].filter(Boolean).join(", ")}
            </p>
          </div>
        ) : null}
      </div>
    </Band>
  );
}

export function StickyBar({
  section,
  config,
}: {
  section: Extract<Section, { type: "stickyBar" }>;
  config: SiteConfig;
}) {
  const loc = config.locations[0];
  const label: Record<string, string> = {
    quote: "Get a quote",
    book: "Book",
    call: "Call",
    whatsapp: "WhatsApp",
  };
  return (
    <nav className={s.sticky} aria-label="Quick actions">
      {section.actions.map((action, i) => (
        <a
          key={action}
          className={s.stickyAction}
          data-primary={i === 0}
          href={resolveAction(action, undefined, section.phone ?? loc?.phone, section.whatsapp ?? loc?.whatsapp)}
        >
          {label[action] ?? action}
        </a>
      ))}
    </nav>
  );
}
