import styles from "./DemoDisclosure.module.css";

/**
 * THE LINE THAT KEEPS A DEMO FROM BEING A FAKE.
 *
 * A demo site carries a real business's name, their suburb and their actual
 * Google rating. Without this it is indistinguishable from that business's
 * own website — which is a live impersonation of somebody trading in their
 * own name, and a legal problem rather than a cosmetic one.
 *
 * It is rendered by SiteRenderer, once, for every demo, and no template gets
 * a say. A per-template disclosure is one template away from being missing,
 * and the template that forgets is the one that ships on a Friday.
 *
 * Deliberately NOT dismissible and not `position: fixed` over content that
 * could scroll it away. It states three things a reader needs in order not to
 * be misled: who made this, that it is a proposal rather than the business's
 * site, and that there is no relationship between us and them.
 */
export function DemoDisclosure({
  subjectName,
  expiresAt,
}: {
  subjectName: string;
  expiresAt: number;
}) {
  const expires = new Date(expiresAt).toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <aside className={styles.bar} role="note" aria-label="About this page">
      <p className={styles.line}>
        <strong className={styles.lede}>This is a proposal, not {subjectName}&rsquo;s website.</strong>{" "}
        It was prepared by The Creative Current to show what one could look
        like. We are not affiliated with {subjectName} and this page is not
        operated by them.
      </p>
      <p className={styles.meta}>
        Any imagery is illustrative and does not depict work by {subjectName}.
        This preview comes down on {expires}.
      </p>
    </aside>
  );
}

/**
 * What an expired demo serves INSTEAD of the site.
 *
 * A notice, never the page. The backend already refuses to return the config
 * past the expiry, so this renders from nothing — which is the point: there
 * is no path where an expired demo can still assemble the business's page.
 */
export function DemoExpired() {
  return (
    <main className={styles.expired}>
      <h1 className={styles.expiredTitle}>This preview has expired</h1>
      <p className={styles.expiredBody}>
        It was a proposal prepared by The Creative Current and was never the
        website of the business it described. Nothing here is live.
      </p>
      <p className={styles.expiredBody}>
        If you were sent this link and would like it reopened, reply to the
        message it came in.
      </p>
    </main>
  );
}
