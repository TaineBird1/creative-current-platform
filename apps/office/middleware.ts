import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";

/**
 * Route protection at the EDGE, not in a component.
 *
 * This is defence in depth, not the security boundary. The real boundary is
 * every Convex function re-deriving its tenant from the authenticated user —
 * a middleware bypass still reaches nothing. What this buys is that an
 * unauthenticated person sees a sign-in screen rather than a flash of empty
 * console chrome.
 */
const isSignIn = createRouteMatcher(["/admin/sign-in", "/c/:slug/sign-in"]);
const isProtected = createRouteMatcher(["/admin(.*)", "/c/:slug(.*)"]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  const { pathname } = request.nextUrl;

  if (isSignIn(request)) {
    if (await convexAuth.isAuthenticated()) {
      // Already in. Bounce to the thing they were trying to reach.
      return nextjsMiddlewareRedirect(request, pathname.replace(/\/sign-in$/, "") || "/admin");
    }
    return;
  }

  if (isProtected(request) && !(await convexAuth.isAuthenticated())) {
    const base = pathname.startsWith("/admin")
      ? "/admin"
      : `/c/${pathname.split("/")[2] ?? ""}`;
    return nextjsMiddlewareRedirect(request, `${base}/sign-in`);
  }
});

export const config = {
  // The backslash MUST be escaped for the JS string, or `\.` collapses to `.`
  // and the lookahead becomes "exclude any path with at least one character" —
  // which silently disables the middleware on every route except "/". It fails
  // open, so nothing errors and every protected page just renders.
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
