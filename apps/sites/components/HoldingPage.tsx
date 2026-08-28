import h from "./holding.module.css";

/**
 * THE FAILURE MODE.
 *
 * Part 0's rule: an invalid or missing config renders a branded holding page,
 * NEVER another tenant's content. This component is that page, and it is the
 * only thing a visitor sees when resolution fails — so it must be complete,
 * calm, and give them the one thing they actually came for where we have it.
 *
 * It carries no client data beyond what the caller passes, because in the
 * failure cases we frequently do not know whose site this was meant to be.
 */
export function HoldingPage({
  reason,
  businessName,
  phone,
}: {
  reason: "unknown" | "unpublished" | "expired" | "invalid";
  businessName?: string;
  phone?: string;
}) {
  const copy = MESSAGES[reason];

  return (
    // No accent is injected: in most failure cases we do not know whose site
    // this was meant to be. .world-client's neutral --accent-* fallbacks exist
    // for exactly this, and inventing a colour here would be inventing a brand.
    <div className="world-client">
      <main className={h.wrap}>
        <div className={h.inner}>
          {businessName ? <p className={h.name}>{businessName}</p> : null}
          <h1 className={h.heading}>{copy.heading}</h1>
          <p className={h.body}>{copy.body}</p>
          {phone ? (
            <a className={`${h.phone} tabular`} href={`tel:${phone}`}>
              {phone}
            </a>
          ) : null}
        </div>
      </main>
    </div>
  );
}

const MESSAGES: Record<
  "unknown" | "unpublished" | "expired" | "invalid",
  { heading: string; body: string }
> = {
  unknown: {
    heading: "This address is not in use.",
    body: "Nothing is published here. If you followed a link, it may be out of date.",
  },
  unpublished: {
    heading: "This site is not live yet.",
    body: "It is being built. Check back shortly.",
  },
  expired: {
    heading: "This preview has expired.",
    body: "Demo sites are available for 30 days. Ask us for a fresh link.",
  },
  invalid: {
    heading: "This site is temporarily unavailable.",
    body: "We have been notified and are looking at it. Phoning is the fastest route in the meantime.",
  },
};
