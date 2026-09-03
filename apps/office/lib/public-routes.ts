/**
 * THE ONLY LIST OF PATHS THAT MAY BE REACHED WITHOUT A SESSION.
 *
 * The office serves three populations from ONE origin — the owner console at
 * `/admin`, every client's back office at `/c/<slug>`, and now a document at
 * `/i/<token>` that a stranger is supposed to open. That last one is the odd
 * member and it is load-bearing: the person who most needs to read an invoice
 * is the client's BOOKKEEPER, who has no account here and never will.
 *
 * THIS FILE EXISTS BECAUSE THE EXCEPTION USED TO BE AN ABSENCE.
 *
 * The middleware previously listed what was PROTECTED — `/admin(.*)` and
 * `/c/:slug(.*)` — and everything else was public by omission. `/i/<token>`
 * worked because nothing had been written down about it. That is fail-OPEN,
 * and it is wrong in both directions at once:
 *
 *   Add a new authenticated area and forget the protected list, and it is
 *   served to anybody. Nothing errors. Nothing looks wrong.
 *
 *   Tighten the middleware to a catch-all later — the obvious hardening, and
 *   the one somebody eventually does — and every invoice link already sitting
 *   in a client's inbox starts redirecting to a sign-in page. Nobody finds
 *   out until a client cannot pay, which is a fortnight later and reads as
 *   "your system is broken".
 *
 * So the default is inverted. EVERYTHING THE MIDDLEWARE SEES REQUIRES A
 * SESSION unless it is named below. Both mistakes now fail the recoverable
 * way: a new private route is protected before anybody remembers to protect
 * it, and a new public route that nobody listed is visibly broken in
 * development rather than quietly open in production.
 *
 * THE MIDDLEWARE HOLDS NO ROUTE LITERALS OF ITS OWN. It asks this module and
 * nothing else, so there is one place to read and one place to change.
 * `office-routes.test.ts` asserts the id set below EQUALS the intended set —
 * not that it contains `/i` — so adding a sixth public path fails CI until
 * somebody edits the test, which is the moment the decision gets made.
 *
 * WHAT THIS IS NOT. Same caveat as always: route protection here is a UX
 * affordance, not the security boundary. The boundary is every Convex
 * function re-deriving its tenant from the authenticated user. A forged
 * cookie gets past this file and then reaches nothing.
 */

export const ADMIN_SIGN_IN = "/admin/sign-in";

/**
 * One entry per public path. `id` is what the guard test pins; `matches` is
 * the actual rule, written out rather than expressed as a pattern language so
 * that reading it requires no second document.
 */
type PublicRoute = {
  id: string;
  /** Why this one may be reached with no session. */
  why: string;
  matches: (segments: string[], pathname: string) => boolean;
};

const PUBLIC_ROUTES: readonly PublicRoute[] = [
  {
    id: "root",
    why: "A bare redirect into /admin, which then does the bouncing itself.",
    matches: (_segments, pathname) => pathname === "/",
  },
  {
    id: "admin-sign-in",
    why: "You cannot require a session to reach the page that creates one.",
    matches: (_segments, pathname) => pathname === ADMIN_SIGN_IN,
  },
  {
    id: "client-sign-in",
    why: "The same, per client, and branded with their colours before anyone has signed in.",
    matches: (segments) =>
      segments.length === 3 && segments[0] === "c" && segments[2] === "sign-in",
  },
  {
    id: "invoice-view",
    why:
      "THE DOCUMENT. The token in the path is the credential — 256 random bits, " +
      "revocable, resolving exactly one invoice. A login here is an invoice nobody opens.",
    /*
     * Deliberately matched on SHAPE, not on a valid-looking token. A mangled
     * link — truncated by a chat client, broken across a line in an email —
     * must reach the page and be told "that link is not valid" by the backend
     * that actually knows. Redirecting it to a sign-in screen instead tells a
     * bookkeeper they need an account, which is the one thing that is not
     * true and the one thing they cannot fix.
     */
    matches: (segments) =>
      segments.length === 2 && segments[0] === "i" && segments[1]!.length > 0,
  },
  {
    id: "preview-harness",
    why:
      "Dev-only fixtures harness. Listed rather than left implicit — its point is to be " +
      "readable WITHOUT signing in, and it cannot exist in a production build at all.",
    /*
     * Three independent barriers already keep this off production: the file
     * is `page.preview.tsx` so Next never routes it, `ALLOW_PREVIEW_ROUTES`
     * is absent from turbo.json so a Vercel build cannot see the flag, and
     * the component refuses to render without it. Naming it here changes
     * nothing about that and makes the exception visible instead of implied.
     */
    matches: (segments) => segments[0] === "preview",
  },
] as const;

/** The pinned surface. `office-routes.test.ts` asserts this equals the intended set. */
export const PUBLIC_ROUTE_IDS: readonly string[] = PUBLIC_ROUTES.map((r) => r.id);

/** Exported so the guard can assert each entry says why it is public. */
export const PUBLIC_ROUTE_REASONS: ReadonlyMap<string, string> = new Map(
  PUBLIC_ROUTES.map((r) => [r.id, r.why]),
);

function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/** A trailing slash is the same path. Next normalises, but this does not assume it. */
function normalise(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

export function isPublicPath(pathname: string): boolean {
  const path = normalise(pathname);
  const segments = segmentsOf(path);
  return PUBLIC_ROUTES.some((route) => route.matches(segments, path));
}

/**
 * THE DEFAULT, stated as a function so it reads the right way round at the
 * call site: a path requires a session unless something says otherwise.
 */
export function requiresSession(pathname: string): boolean {
  return !isPublicPath(pathname);
}

export function isSignInPath(pathname: string): boolean {
  const path = normalise(pathname);
  const segments = segmentsOf(path);
  return (
    path === ADMIN_SIGN_IN ||
    (segments.length === 3 && segments[0] === "c" && segments[2] === "sign-in")
  );
}

/**
 * Where to send somebody who needs a session and has not got one.
 *
 * A client's back office bounces to THEIR branded sign-in, because being sent
 * to the owner console's would tell them they are in the wrong place. Anything
 * else — including a path nobody has thought about — goes to the admin one.
 */
export function signInPathFor(pathname: string): string {
  const segments = segmentsOf(normalise(pathname));
  if (segments[0] === "c" && segments[1]) return `/c/${segments[1]}/sign-in`;
  return ADMIN_SIGN_IN;
}

/** Where to send somebody who is ALREADY signed in and landed on a sign-in page. */
export function afterSignInPathFor(pathname: string): string {
  const path = normalise(pathname);
  const stripped = path.replace(/\/sign-in$/, "");
  return stripped || "/admin";
}
