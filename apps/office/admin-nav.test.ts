// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { expectNoOffenders } from "../../test-support/negative";
import { ADMIN_SCREENS, ADMIN_ROUTES_WITHOUT_NAV } from "./components/admin-screens";

/**
 * CAN YOU GET THERE FROM HERE?
 *
 * Every admin screen in this repo has been built, deployed, protected by the
 * middleware, and — twice now — reachable only by typing its URL. `/admin/queue`
 * shipped with no link to it anywhere. `/admin/issuer` shipped with a link
 * that rendered ONLY inside the "you are not platform staff" branch of the
 * console: present on the screen where every link would refuse, absent on the
 * screen where they all work. Since the console is where every session lands,
 * that read as no nav existing at all, and the owner spent a fortnight typing
 * paths from memory.
 *
 * Neither failure threw, logged, or failed a test. That is the whole problem:
 * NOBODY REPORTS NOT HAVING FOUND A THING. It is the same family as the `dig`
 * command that could not run on Windows — an absent barrier rather than a weak
 * one, leaving no trace of not having worked.
 *
 * TWO INVARIANTS, BECAUSE EACH HAS FAILED ON ITS OWN:
 *
 *   1. Every admin page's TOP BAR renders the nav. Not "the file mentions
 *      AdminNav" — `page.tsx` contained `<AdminNav />` throughout the bug, in
 *      the wrong branch, so a file-level scan would have been green against a
 *      console with no navigation on it. The unit that matters is the header.
 *   2. Every admin page has an ENTRY in the list. A screen added tomorrow with
 *      a perfectly rendered nav that does not mention it is invisible in
 *      exactly the same way.
 */

const ADMIN_DIR = join(__dirname, "app", "admin");

/**
 * Comments stripped, for the reason every guard in this repo strips them: the
 * prose most likely to sit beside a rule is the paragraph explaining it. The
 * comment above this line names `<AdminNav />` twice.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every `page.tsx` under app/admin, with the route each one serves. */
function adminPages(): Array<{ route: string; file: string; code: string }> {
  const found: Array<{ route: string; file: string; code: string }> = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name === "page.tsx") {
        const segments = relative(ADMIN_DIR, dir).split(sep).filter(Boolean);
        found.push({
          route: ["/admin", ...segments].join("/").replace(/\/$/, ""),
          file: relative(__dirname, path),
          code: stripComments(readFileSync(path, "utf8")),
        });
      }
    }
  };

  walk(ADMIN_DIR);
  return found;
}

const PAGES = adminPages();

/**
 * NAMED, not just counted. A count alone survives a walker pointed at the
 * wrong tree — collect `.ts` from a directory of `.tsx` and every rule built
 * on it passes against an empty list. These two are the screens whose absence
 * caused the bugs above, so a walk that cannot see them has not run.
 */
const MUST_HAVE_FOUND = ["/admin", "/admin/issuer"];

describe("the walk itself", () => {
  test("it found the admin pages, and names them", () => {
    const routes = PAGES.map((p) => p.route);
    for (const required of MUST_HAVE_FOUND) {
      expect(routes, `the walk missed ${required}, so it proves nothing`).toContain(required);
    }
    expect(routes.length).toBeGreaterThanOrEqual(ADMIN_SCREENS.length);
  });
});

describe("every top bar carries the nav", () => {
  /**
   * The unit is the HEADER, not the file.
   *
   * `<header className={s.topbar}>` is the admin shell's one navigation bar.
   * A page may render more than one — the console has a second inside its
   * refusal branch — and EVERY one of them has to carry the nav, because a
   * reader only ever sees one of them and cannot know which.
   */
  const TOPBAR = /<header className=\{s\.topbar\}>([\s\S]*?)<\/header>/g;

  const bars: Array<{ file: string; body: string }> = [];
  for (const page of PAGES) {
    for (const match of page.code.matchAll(TOPBAR)) {
      bars.push({ file: page.file, body: match[1] ?? "" });
    }
  }

  test("the pattern matches a real top bar", () => {
    /*
     * The control on the control. A regex that matches nothing would report
     * every page clean, and this exact shape of vacuity — a pattern quietly
     * unable to match — is what `expectAbsent` exists to prevent elsewhere.
     */
    const sample = "<header className={s.topbar}>\n  <AdminNav />\n</header>";
    expect(
      [...sample.matchAll(TOPBAR)].length,
      "the top-bar pattern cannot see a top bar, so its verdict means nothing",
    ).toBe(1);
  });

  test("no top bar is missing it", () => {
    expectNoOffenders({
      offenders: bars
        .filter((bar) => !bar.body.includes("<AdminNav"))
        .map((bar) => bar.file),
      examined: bars.length,
      because:
        "This top bar renders no <AdminNav />, so whoever lands on it can only " +
        "leave by typing a URL. Note that the FILE may well import and render " +
        "one elsewhere — that is exactly how /admin shipped with a nav on its " +
        "refusal screen and none on the console.",
    });
  });
});

describe("every page renders it at all", () => {
  /**
   * THE WEAKER RULE, KEPT BECAUSE IT COVERS WHAT THE STRONGER ONE CANNOT SEE.
   *
   * Four admin pages — issuer, clients/new, leads/import, domains — have no
   * `s.topbar` in them at all; they place `<AdminNav />` at the top level and
   * follow it with their own page header. The top-bar rule above examines zero
   * headers on those files and would stay green if the nav were deleted from
   * every one of them.
   *
   * So this is the file-level check, and it is deliberately the rung of the
   * ladder that failed to catch the original bug: `/admin/page.tsx` satisfied
   * exactly this test while the console had no navigation on it. On its own it
   * is not enough. Alongside the header rule it closes the other half — total
   * removal, on a page with no header to inspect.
   */
  test("no admin page is without a nav", () => {
    const exempt = new Set<string>(ADMIN_ROUTES_WITHOUT_NAV);

    expectNoOffenders({
      offenders: PAGES.filter(
        (page) => !exempt.has(page.route) && !page.code.includes("<AdminNav"),
      ).map((page) => page.file),
      examined: PAGES.length,
      because:
        "This admin page renders no nav anywhere, so it is a dead end. If that " +
        "is deliberate, add its route to ADMIN_ROUTES_WITHOUT_NAV and say why.",
    });
  });
});

describe("every screen is listed", () => {
  test("no admin page is missing from the nav", () => {
    const listed = new Set<string>([
      ...ADMIN_SCREENS.map((s) => s.href),
      ...ADMIN_ROUTES_WITHOUT_NAV,
    ]);

    expectNoOffenders({
      offenders: PAGES.map((p) => p.route).filter((route) => !listed.has(route)),
      examined: PAGES.length,
      because:
        "This screen exists and nothing links to it. Add it to ADMIN_SCREENS in " +
        "components/admin-screens.ts, or to ADMIN_ROUTES_WITHOUT_NAV if it is " +
        "deliberately unreachable — but write down which.",
    });
  });

  test("the nav lists nothing that does not exist", () => {
    /*
     * The other direction, which fails differently and worse: a link to a
     * deleted screen is a 404 the owner meets mid-task, having done nothing
     * wrong. Cheap to check while the list is already in hand.
     */
    const routes = new Set(PAGES.map((p) => p.route));
    expectNoOffenders({
      offenders: ADMIN_SCREENS.map((s) => s.href).filter((href) => !routes.has(href)),
      examined: ADMIN_SCREENS.length,
      because: "The nav links to a screen with no page.tsx behind it. That is a 404.",
    });
  });
});
