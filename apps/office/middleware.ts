import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";

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
 */
const isSignIn = createRouteMatcher(["/admin/sign-in", "/c/:slug/sign-in"]);
const isProtected = createRouteMatcher(["/admin(.*)", "/c/:slug(.*)"]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  const { pathname } = request.nextUrl;

  // Cookie presence only. No network call, no verification.
  const hasSession = (await convexAuth.getToken()) !== undefined;

  if (isSignIn(request)) {
    if (hasSession) {
      return nextjsMiddlewareRedirect(request, pathname.replace(/\/sign-in$/, "") || "/admin");
    }
    return;
  }

  if (isProtected(request) && !hasSession) {
    const base = pathname.startsWith("/admin")
      ? "/admin"
      : `/c/${pathname.split("/")[2] ?? ""}`;
    return nextjsMiddlewareRedirect(request, `${base}/sign-in`);
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
  matcher: ["/((?!_next|.*[.].*).*)", "/", "/(api|trpc)(.*)"],
};
