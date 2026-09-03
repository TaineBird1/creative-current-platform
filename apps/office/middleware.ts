import {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import {
  afterSignInPathFor,
  isSignInPath,
  requiresSession,
  signInPathFor,
} from "./lib/public-routes";

/**
 * Route protection here is a UX affordance, NOT the security boundary.
 *
 * The boundary is every Convex function re-deriving its tenant from the
 * authenticated user. A forged or stale cookie gets past this middleware and
 * then reaches nothing: the query refuses and the page says so. What this
 * buys is that an unauthenticated visitor sees a sign-in screen rather than a
 * flash of empty console chrome.
 *
 * So it checks the PRESENCE of a session token, not its validity.
 *
 * `convexAuth.isAuthenticated()` would verify the JWT, which costs a network
 * round trip on every single request to duplicate a check Convex already
 * performs authoritatively. Presence here, verification there — and the
 * back office renders an explicit "session expired" state, with a sign-out
 * escape, for the case this check waves through and Convex then rejects.
 *
 * (Historical note, because the code briefly claimed otherwise: verification
 * here was first removed after blaming the middleware runtime's networking.
 * That diagnosis was wrong. The real fault was a JWKS environment variable
 * mangled by shell quoting, which broke token verification EVERYWHERE. The
 * change survives on the reasoning above, not on that one.)
 *
 * EVERY PATH REQUIRES A SESSION UNLESS `lib/public-routes.ts` SAYS OTHERWISE,
 * and this file holds no route literals of its own outside `config.matcher`
 * below, which Next requires to be a static literal. It used to list what was
 * PROTECTED, which made `/i/<token>` public by omission — see that module for
 * why an absence was the wrong way to hold a decision this size.
 */
export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  const { pathname } = request.nextUrl;

  // Cookie presence only. No network call, no verification.
  const hasSession = (await convexAuth.getToken()) !== undefined;

  if (isSignInPath(pathname)) {
    if (hasSession) {
      return nextjsMiddlewareRedirect(request, afterSignInPathFor(pathname));
    }
    return;
  }

  if (requiresSession(pathname) && !hasSession) {
    return nextjsMiddlewareRedirect(request, signInPathFor(pathname));
  }
});

export const config = {
  // `[.]` rather than the conventional `\.` — ON PURPOSE.
  //
  // A backslash here must survive being written into a JS string. Get it
  // wrong and `\.` collapses to `.`, so the lookahead reads "exclude any path
  // with at least one character" and the middleware silently stops running on
  // every route except "/". Nothing errors, nothing warns, every protected
  // page just renders. That cost two debugging rounds in one session.
  //
  // A character class means exactly the same thing and cannot be mangled.
  //
  // THIS MUST STAY A CATCH-ALL, and it is the one place route literals are
  // unavoidable: Next reads `config.matcher` statically at build time, so it
  // cannot be an imported constant. Narrowing it does not make anything
  // public in a visible way — it makes the middleware stop running, which
  // for `/admin` means the console renders to a stranger. office-routes.test
  // asserts the catch-all entry is still here.
  matcher: ["/((?!_next|.*[.].*).*)", "/", "/(api|trpc)(.*)"],
};
