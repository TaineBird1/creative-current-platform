// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ADMIN_SIGN_IN,
  PUBLIC_ROUTE_IDS,
  PUBLIC_ROUTE_REASONS,
  afterSignInPathFor,
  isPublicPath,
  isSignInPath,
  requiresSession,
  signInPathFor,
} from "./lib/public-routes";

/**
 * THE PUBLIC SURFACE OF THE OFFICE ORIGIN.
 *
 * `app.thecreativecurrent.co.za` serves the owner console, every client's
 * back office, and one document a stranger is meant to open. That last one is
 * the exception, and an exception nobody has written down is an exception
 * that gets removed by somebody doing sensible work.
 *
 * Both directions cost, and they cost differently:
 *
 *   TOO TIGHT — a catch-all lands and `/i/<token>` starts bouncing to a
 *   sign-in page. Every invoice link already in a client's inbox is dead. It
 *   throws nothing, logs nothing, and surfaces a fortnight later as a client
 *   who cannot pay and assumes we are broken.
 *
 *   TOO LOOSE — somebody widens the public list to unblock something else,
 *   and an authenticated route goes with it. Worse, and silent in the way
 *   that matters: the page renders perfectly.
 *
 * So the set is pinned by EQUALITY, not by membership. A sixth public path
 * fails this file until a person edits it, which is the moment the decision
 * is actually made rather than inherited.
 */

const OFFICE_DIR = __dirname;

/**
 * THE INTENDED SET, written out here a second time on purpose.
 *
 * A test that imported the list and asserted the list equals itself would
 * pass against anything. This is the independent copy — the negative control
 * is that adding an entry to `lib/public-routes.ts` and nothing else turns
 * this red.
 */
const INTENDED_PUBLIC_ROUTES = [
  "admin-sign-in",
  "client-sign-in",
  "invoice-view",
  "preview-harness",
  "root",
] as const;

/**
 * Comments stripped, for the reason convex/guards.test.ts strips them: a rule
 * that scans prose fires on the paragraph explaining the rule. The middleware
 * comment block below names `/admin` and `/i` repeatedly, and the
 * "no route literals" check would pass on that prose alone.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function read(relative: string) {
  const raw = readFileSync(join(OFFICE_DIR, relative), "utf8");
  return { raw, code: stripComments(raw) };
}

const middleware = read("middleware.ts");
const routes = read("lib/public-routes.ts");

describe("the guard is looking at something", () => {
  /*
   * Both files, by name, and non-empty. A guard pointed at a moved or renamed
   * file reports safety it never checked, and it does it in green — the
   * failure that made three of four preview controls pass against
   * deliberately broken code.
   */
  test("it read both files it reasons about", () => {
    expect(middleware.raw.length, "apps/office/middleware.ts is empty or missing").toBeGreaterThan(
      500,
    );
    expect(
      routes.raw.length,
      "apps/office/lib/public-routes.ts is empty or missing",
    ).toBeGreaterThan(500);
    expect(middleware.code).toContain("convexAuthNextjsMiddleware");
    expect(routes.code).toContain("PUBLIC_ROUTE_IDS");
  });

  test("stripping comments did not empty the files it scans", () => {
    expect(middleware.code.length).toBeGreaterThan(300);
    expect(routes.code.length).toBeGreaterThan(300);
  });
});

describe("the public set is exactly what was decided", () => {
  test("EQUALS the intended set — not contains", () => {
    expect([...PUBLIC_ROUTE_IDS].sort()).toEqual([...INTENDED_PUBLIC_ROUTES].sort());
  });

  test("every public route says why it is public", () => {
    for (const id of PUBLIC_ROUTE_IDS) {
      const why = PUBLIC_ROUTE_REASONS.get(id);
      expect(why, `${id} has no stated reason for being public`).toBeTruthy();
      expect(why!.length, `${id}'s reason is too short to be one`).toBeGreaterThan(30);
    }
  });
});

describe("the exception actually works", () => {
  test("an invoice link needs no session", () => {
    const token = "a".repeat(64);
    expect(requiresSession(`/i/${token}`)).toBe(false);
    expect(isPublicPath(`/i/${token}`)).toBe(true);
  });

  test("A MANGLED TOKEN STILL REACHES THE PAGE", () => {
    /*
     * Matched on shape, not on a valid-looking token. A link truncated by a
     * chat client must be told "that link is not valid" by the backend that
     * knows — not redirected to a sign-in screen, which tells a bookkeeper
     * they need an account. That is the one thing that is not true and the
     * one thing they cannot fix.
     */
    expect(requiresSession("/i/short")).toBe(false);
    expect(requiresSession("/i/" + "%20broken%20")).toBe(false);
  });

  test("but /i alone, and anything under it, is not the document", () => {
    expect(requiresSession("/i")).toBe(true);
    expect(requiresSession("/i/")).toBe(true);
    expect(requiresSession("/i/token/extra")).toBe(true);
  });
});

describe("everything else requires a session", () => {
  const protectedPaths = [
    "/admin",
    "/admin/queue",
    "/admin/finance",
    "/admin/tasks",
    "/admin/domains",
    "/c/renu-solar",
    "/c/renu-solar/bookings",
    "/c/renu-solar/anything/deeper",
  ];

  test.each(protectedPaths)("%s", (path) => {
    expect(requiresSession(path)).toBe(true);
  });

  test("INCLUDING A PATH NOBODY HAS THOUGHT OF — the default is protect", () => {
    /*
     * The whole point of the inversion. A route added next year is covered
     * before anybody remembers to cover it; the mistake it forces is a
     * developer wondering why their new page redirects, which takes a minute
     * and happens on their own machine.
     */
    expect(requiresSession("/reports")).toBe(true);
    expect(requiresSession("/api/internal")).toBe(true);
    expect(requiresSession("/invoices/1")).toBe(true);
    expect(requiresSession("/i2/token")).toBe(true);
    expect(requiresSession("/ii/token")).toBe(true);
  });

  test("a near-miss on the sign-in paths is protected", () => {
    expect(requiresSession("/c/renu-solar/sign-in/extra")).toBe(true);
    expect(requiresSession("/admin/sign-in-x")).toBe(true);
    expect(requiresSession("/c//sign-in")).toBe(true);
  });
});

describe("the sign-in paths", () => {
  test("are public, or nobody can ever sign in", () => {
    expect(requiresSession(ADMIN_SIGN_IN)).toBe(false);
    expect(requiresSession("/c/renu-solar/sign-in")).toBe(false);
    expect(requiresSession("/")).toBe(false);
  });

  test("are recognised as sign-in pages, so a signed-in visitor is bounced on", () => {
    expect(isSignInPath(ADMIN_SIGN_IN)).toBe(true);
    expect(isSignInPath("/c/renu-solar/sign-in")).toBe(true);
    expect(isSignInPath("/i/" + "a".repeat(64))).toBe(false);
    expect(isSignInPath("/admin")).toBe(false);
  });

  test("and the bounce goes back to where they were headed", () => {
    expect(afterSignInPathFor(ADMIN_SIGN_IN)).toBe("/admin");
    expect(afterSignInPathFor("/c/renu-solar/sign-in")).toBe("/c/renu-solar");
  });

  test("a client is sent to THEIR sign-in, not the owner console's", () => {
    // Being redirected to /admin/sign-in tells a client they are in the wrong
    // place, which is both wrong and alarming.
    expect(signInPathFor("/c/renu-solar/bookings")).toBe("/c/renu-solar/sign-in");
    expect(signInPathFor("/admin/queue")).toBe(ADMIN_SIGN_IN);
    expect(signInPathFor("/something-new")).toBe(ADMIN_SIGN_IN);
  });
});

describe("the preview entry's claim is checked, not asserted", () => {
  /*
   * `preview-harness` sits in the public route list with the reason "cannot
   * exist in a production build at all". That is the single most load-bearing
   * sentence in the table — it is why a route rendering a tenant's customer
   * names and invoice amounts is allowed to be public — and until CI read a
   * real build it was a claim verified by eye, once.
   *
   * This asserts the check RUNS. The check itself lives in
   * scripts/assert-no-preview-route.mjs and its negative control is a build
   * with ALLOW_PREVIEW_ROUTES=1, which it catches in both Next manifests.
   */
  const ci = readFileSync(join(OFFICE_DIR, "..", "..", ".github", "workflows", "ci.yml"), "utf8");

  test("CI runs the build-output guard", () => {
    expect(ci.length, "ci.yml is empty or missing").toBeGreaterThan(1000);
    expect(
      ci,
      "CI must run scripts/assert-no-preview-route.mjs. Without it, " +
        "'cannot exist in a production build' is a comment.",
    ).toContain("scripts/assert-no-preview-route.mjs");
  });

  test("AFTER the office build, or it reads nothing", () => {
    const build = ci.indexOf("pnpm --filter @cc/office build");
    const guard = ci.indexOf("scripts/assert-no-preview-route.mjs");
    expect(build, "the office build step has moved or been renamed").toBeGreaterThan(-1);
    expect(
      guard > build,
      "The guard reads .next/, so it must run after the build. Before it, " +
        "it fails on a missing build — which is correct, and means CI never " +
        "reaches the assertion it exists for.",
    ).toBe(true);
  });

  test("the script refuses a missing build rather than passing", () => {
    const script = readFileSync(
      join(OFFICE_DIR, "..", "..", "scripts", "assert-no-preview-route.mjs"),
      "utf8",
    );
    expect(script).toContain("No build found");
    // A manifest that parsed to nothing would satisfy "no preview route".
    expect(script).toContain("MUST_CONTAIN");
  });
});

describe("the client door does not enumerate the roster", () => {
  /*
   * `/c/<slug>/sign-in` used to fetch the client's name and accent ramp before
   * authenticating, so it rendered their brand. The per-item disclosure was
   * defensible — a name and a colour are on the business's own website — and
   * the unit of analysis was wrong. What a branded door discloses is
   * MEMBERSHIP, and the aggregate of those answers is the client roster,
   * buildable by pointing a wordlist of local installers at this path. That
   * list is exactly what the outreach engine exists to construct.
   *
   * Measured after the change: the rendered document is byte-identical for a
   * real client and two unknown slugs. These guards keep it that way.
   */
  const signIn = read("app/c/[slug]/sign-in/page.tsx");

  test("IT MAKES NO QUERY AT ALL", () => {
    expect(signIn.raw.length, "the client sign-in page is missing").toBeGreaterThan(200);
    for (const forbidden of ["fetchQuery", "useQuery", "convex/nextjs", "convex/react"]) {
      expect(
        signIn.code,
        `The client sign-in page calls ${forbidden}. Any per-slug lookup before ` +
          "authentication makes this page an oracle for whether a business is a " +
          "client, and a wordlist turns that into the roster.",
      ).not.toContain(forbidden);
    }
  });

  test("and renders nothing that could differ by slug", () => {
    // businessName/accent are the two props that carried the branding.
    expect(signIn.code).not.toContain("businessName");
    expect(signIn.code).not.toContain("accent");
  });

  test("the slug is still used for the post-sign-in redirect", () => {
    // Not a leak: the visitor typed that URL, so being sent back to it proves
    // only that they typed it. Dropping it would land a client on /admin.
    expect(signIn.code).toContain("redirectTo");
  });
});

describe("there is one source, and the middleware is not a second one", () => {
  test("the middleware asks the module rather than matching paths itself", () => {
    expect(middleware.code).toContain("./lib/public-routes");
    expect(middleware.code).toContain("requiresSession");
  });

  test("NO ROUTE LITERALS IN THE MIDDLEWARE outside config.matcher", () => {
    /*
     * The single-source half. A second `createRouteMatcher(["/whatever"])`
     * here would work perfectly and be invisible to every assertion above,
     * because those all test the module the middleware would have stopped
     * consulting.
     *
     * `config.matcher` is excluded because Next reads it statically at build
     * time and it therefore cannot be an imported constant. It is asserted
     * separately below.
     */
    const beforeConfig = middleware.code.split("export const config")[0]!;
    const routeLiterals = beforeConfig.match(/["'`]\/[A-Za-z(]/g) ?? [];

    expect(
      routeLiterals,
      `middleware.ts declares its own route paths (${routeLiterals.join(", ")}). ` +
        "Every path decision belongs in lib/public-routes.ts, or there are two answers " +
        "to which routes are public and only one of them is tested.",
    ).toEqual([]);
  });

  test("createRouteMatcher is gone entirely", () => {
    // It only ever built the protected list. Left imported, it is an
    // invitation to add a second, untested opinion beside the module.
    expect(middleware.code).not.toContain("createRouteMatcher");
  });

  test("THE MATCHER IS STILL A CATCH-ALL", () => {
    /*
     * Narrowing config.matcher does not read as making something public — it
     * reads as scoping the middleware. The effect is that it stops running,
     * and a path it stops running on is one where `requiresSession` is never
     * consulted. For /admin that is the console rendering to a stranger.
     */
    expect(middleware.code).toContain('"/((?!_next|.*[.].*).*)"');
  });

  test("the module holds the invoice path and nothing downstream re-decides it", () => {
    expect(routes.code).toContain('segments[0] === "i"');
    expect(routes.code).toContain("requiresSession");
  });
});
