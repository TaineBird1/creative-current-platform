// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A DEMO MAY NOT RENDER WITHOUT ITS GUARANTEES.
 *
 * A demo site carries a real business's name, their suburb and their actual
 * Google rating. Every one of these rules exists because breaking it produces
 * a working, indexable impersonation of a business trading under its own
 * name — not a broken page, a convincing one. That is a legal problem rather
 * than a bug, which is why it is a test and not a note.
 *
 * The rules are all enforced at ONE point, the renderer, and these guards
 * exist to keep it that way. The failure mode being designed against is not
 * "someone removes the disclosure" — it is "someone adds the sixth template
 * and does not know the disclosure was ever their responsibility".
 */

const SITES_DIR = join(__dirname);
const RENDERER = "components/SiteRenderer.tsx";
const DISCLOSURE = "components/DemoDisclosure.tsx";

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

/**
 * Comments stripped, for the same reason convex/guards.test.ts strips them:
 * a rule that scans prose fires on the paragraph explaining it. The
 * "not dismissible" check below caught the comment saying NOT dismissible.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = walk(SITES_DIR).map((f) => {
  const text = readFileSync(f, "utf8");
  return {
    path: relative(SITES_DIR, f).replace(/\\/g, "/"),
    text,
    code: stripComments(text),
  };
});

const renderer = files.find((f) => f.path === RENDERER);
const disclosure = files.find((f) => f.path === DISCLOSURE);

describe("the disclosure is the renderer's job, not a template's", () => {
  test("SiteRenderer renders the disclosure for every demo", () => {
    expect(renderer, `${RENDERER} is missing`).toBeTruthy();
    expect(renderer!.text).toMatch(/<DemoDisclosure/);
  });

  test("SiteRenderer refuses to render a demo without its context", () => {
    /*
     * Fail closed. A demo with no disclosure context is not rendered plainly,
     * it is not rendered at all — because the plain version is precisely the
     * indistinguishable fake.
     */
    expect(renderer!.text).toMatch(/if\s*\(\s*isDemo\s*&&\s*!\s*demo\s*\)/);
    expect(renderer!.text).toMatch(/throw new Error\(/);
  });

  test("SiteRenderer refuses to render an expired demo", () => {
    expect(renderer!.text).toMatch(/expiresAt\s*<=\s*Date\.now\(\)/);
  });

  test("no section or template component decides any of this", () => {
    /*
     * THE RULE THIS FILE IS FOR. If a section can ask whether it is in a demo,
     * then some section will handle it differently, and the disclosure becomes
     * five decisions instead of one. One template missing a meta tag is a live
     * fake of somebody's business.
     */
    const offenders: string[] = [];
    for (const file of files) {
      if (file.path === RENDERER || file.path === DISCLOSURE) continue;
      // The module that DECIDES what a demo may assert. It is the one place
      // allowed to branch on it, which is the arrangement being enforced.
      if (file.path === "lib/demo-safety.ts") continue;
      if (file.path.startsWith("app/")) continue; // routes wire props through
      if (/\bisDemo\b|\bDemoDisclosure\b/.test(file.code)) {
        offenders.push(`${file.path}: reads isDemo`);
      }
    }
    expect(
      offenders,
      [
        "Demo handling belongs in SiteRenderer and nowhere else. A section that",
        "can see isDemo is a section that can get it wrong, and the one that",
        "gets it wrong is a working impersonation of a real business.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("the disclosure names the agency, the proposal and the non-affiliation", () => {
    // All three, because any two of them still read as the business's own
    // page built by an agency they hired.
    expect(disclosure, `${DISCLOSURE} is missing`).toBeTruthy();
    expect(disclosure!.text).toMatch(/The Creative Current/);
    expect(disclosure!.text).toMatch(/proposal/i);
    expect(disclosure!.text).toMatch(/not affiliated/i);
  });

  test("it states the expiry date and that imagery is not their work", () => {
    expect(disclosure!.text).toMatch(/expires|comes down on/i);
    expect(disclosure!.text).toMatch(/illustrative|does not depict/i);
  });

  test("the disclosure cannot be dismissed or scrolled out of the way", () => {
    // A bar that can be closed is a bar that can be screenshotted away, and
    // the screenshot is what gets forwarded.
    const css = files.find((f) => f.path === "components/DemoDisclosure.module.css");
    const style = css?.text ?? readFileSync(join(SITES_DIR, "components/DemoDisclosure.module.css"), "utf8");
    expect(style).not.toMatch(/position:\s*fixed/);
    expect(disclosure!.code).not.toMatch(/onClick|useState|dismiss/i);
  });
});

describe("a demo is never indexable", () => {
  test("metadata forces noindex for a demo regardless of the site's own seo", () => {
    const page = files.find((f) => f.path === "app/[[...slug]]/page.tsx");
    expect(page, "the site route is missing").toBeTruthy();
    // seo.noindex OR isDemo — the site's own config cannot opt a demo in.
    expect(page!.code).toMatch(/seo\.noindex\s*\|\|\s*isDemo/);
    expect(page!.code).toMatch(/index:\s*false,\s*follow:\s*false/);
  });

  test("robots.txt denies everything on a demo host", () => {
    const robots = files.find((f) => f.path === "app/robots.txt/route.ts");
    expect(robots!.text).toMatch(/isDemo/);
    expect(robots!.text).toMatch(/DISALLOW_ALL/);
  });

  test("a demo is never in a sitemap", () => {
    const sitemap = files.find((f) => f.path === "app/sitemap.xml/route.ts");
    expect(sitemap!.text).toMatch(/isDemo/);
  });

  test("an expired demo serves the notice, not the site", () => {
    const page = files.find((f) => f.path === "app/[[...slug]]/page.tsx");
    expect(page!.text).toMatch(/demo_expired/);
    expect(page!.text).toMatch(/<DemoExpired\s*\/>/);
  });
});

describe("the link preview carries the framing too", () => {
  /**
   * Sending the demo over WhatsApp is the intended flow, so the scraped card
   * is the FIRST thing a prospect sees — before the page, and before the
   * disclosure bar on it. `noindex` is irrelevant here: it tells search
   * engines not to list the page and says nothing to a scraper, which reads
   * the OG tags and renders them.
   */
  const page = () => files.find((f) => f.path === "app/[[...slug]]/page.tsx")!;

  test("a demo's OG title and description both come from the demo card", () => {
    // Correcting only the title leaves the business's own marketing copy
    // underneath it, and the card as a whole still reads as theirs.
    const text = page().code;
    expect(text).toMatch(/demoPreviewCard\(/);
    expect(text).toMatch(/openGraph:\s*\{[\s\S]*?title,[\s\S]*?description,/);
  });

  test("twitter card metadata is set explicitly, not left to fall back", () => {
    // The OG fallback is a convention that mostly holds, and "mostly" is not
    // the standard for how somebody's business is represented in a message
    // they did not send.
    expect(page().code).toMatch(/twitter:\s*\{[\s\S]*?card:/);
  });

  test("the og:site_name is not the business's own brand on a demo", () => {
    // It is the line a reader trusts most on a forwarded link — it is what
    // tells them who sent this.
    expect(page().code).toMatch(/siteName:\s*card\s*\?/);
  });

  test("the demo card names the agency and denies the affiliation", () => {
    const safety = files.find((f) => f.path === "lib/demo-safety.ts");
    expect(safety, "lib/demo-safety.ts is missing").toBeTruthy();
    expect(safety!.text).toMatch(/Proposal for/);
    expect(safety!.text).toMatch(/not affiliated/i);
  });
});

describe("a demo asserts nothing machine-readable", () => {
  test("LocalBusiness markup is absent on a demo, not softened", () => {
    /*
     * Schema markup is the one format built to be believed without a human
     * reading it, so a correct-looking record with a caveat in a field
     * nothing parses is still an assertion that this business trades here.
     */
    const safety = files.find((f) => f.path === "lib/demo-safety.ts")!;
    expect(safety.code).toMatch(/if\s*\(\s*options\.isDemo\s*\)\s*return null/);
  });

  test("only the renderer emits structured data", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.path === RENDERER || file.path === "lib/demo-safety.ts") continue;
      if (/application\/ld\+json/.test(file.code)) {
        offenders.push(`${file.path}: emits JSON-LD`);
      }
    }
    expect(
      offenders,
      "Structured data goes through localBusinessJsonLd, which returns null for a demo. A second emitter is a second place to forget.",
    ).toEqual([]);
  });

  test("no aggregateRating is asserted anywhere", () => {
    /*
     * The field most likely to be added next, and the one that must not be.
     * A rating is Google's 30-day licensed content; restating it as our own
     * structured claim puts it on a page that outlives the licence.
     */
    const offenders = files
      .filter((f) => /aggregateRating/.test(f.code))
      .map((f) => f.path);
    expect(offenders, "See convex/lib/places.ts — a rating is licensed for 30 days.").toEqual([]);
  });
});

describe("a demo form says nothing was booked", () => {
  /**
   * Silence reads as success. A demo submission is logged as engagement and
   * reaches nobody, so a form that answers for itself says "Thanks — that is
   * with us", and a real customer who found the demo waits in for a tradesman
   * nobody sent. Same fail-open shape as the rest of these rules.
   */
  test("the form displays the SERVER's verdict rather than deciding", () => {
    const form = files.find((f) => f.path === "components/sections/QuoteForm.tsx")!;
    expect(form.code).toMatch(/setNotice\(/);
    expect(form.code).toMatch(/if\s*\(\s*notice\s*\)/);
  });

  test("the server notice outranks the configured success message", () => {
    // A reassuring line from the template underneath the notice would undo
    // the whole point of sending one.
    const form = files.find((f) => f.path === "components/sections/QuoteForm.tsx")!;
    const noticeAt = form.code.indexOf("if (notice)");
    const successAt = form.code.indexOf("section.successMessage");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(successAt);
  });

  test("the action carries the verdict through instead of discarding it", () => {
    const action = files.find((f) => f.path === "app/actions.ts")!;
    expect(action.code).toMatch(/notice:\s*result\.notice/);
  });

  test("the form still does not read isDemo — the notice is content, not a flag", () => {
    // Sections receive a pre-decided message. They never decide.
    const form = files.find((f) => f.path === "components/sections/QuoteForm.tsx")!;
    expect(/\bisDemo\b/.test(form.code)).toBe(false);
  });
});
