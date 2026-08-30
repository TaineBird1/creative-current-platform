import "server-only";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { convexClient } from "@/lib/convex";
import { api } from "@cc/convex/api";
import type { FunctionReturnType } from "convex/server";

/**
 * SITE RESOLUTION, CACHED.
 *
 * The rule this exists to keep: `apps/sites` does not query Convex per
 * pageview. Convex spend must scale with bookings and admin usage, not with
 * traffic — which matters more than it looks, because EU deployments carry no
 * included usage and bill on demand from the first call.
 *
 * What is cached is the RESOLUTION, not the route. Host-based multi-tenancy
 * means reading `headers()`, and that makes the route dynamic no matter what
 * we export — so the page still renders per request, but it renders from a
 * cache entry instead of a round trip to Ireland. A hot site serves thousands
 * of pageviews on one Convex call.
 *
 * Invalidation is tag-based and pushed from Convex on write (see
 * `convex/siteRevalidate.ts`). `revalidate` below is the safety net, not the
 * mechanism: if a webhook is ever dropped, a site self-heals within the hour
 * rather than serving a stale config until someone notices.
 */

/** A missed revalidation should heal on its own. Not the primary mechanism. */
const FALLBACK_REVALIDATE_SECONDS = 3600;

export type ResolvedSite = FunctionReturnType<typeof api.public.site.resolve>;

/**
 * Tag names are a contract with `convex/siteRevalidate.ts`. Both sides import
 * their shape from this comment and nothing else, so keep them boring:
 *
 *   site:slug:<slug>   every cache entry reached by that slug
 *   site:host:<host>   every cache entry reached by that custom domain
 *
 * A write revalidates the slug tag plus one host tag per mapped domain,
 * because a lookup by host never learns the slug until after it has resolved —
 * too late to tag with it.
 */
export const slugTag = (slug: string) => `site:slug:${slug.toLowerCase()}`;
export const hostTag = (host: string) => `site:host:${host.toLowerCase()}`;

/**
 * Resolve a request to a tenant.
 *
 * `preview` bypasses the Next cache entirely. The `?site=` escape hatch exists so
 * an editor can see a change immediately; serving it from cache would make the
 * preview lie, which is worse than the call it saves.
 */
export const resolveSite = cache(async function resolveSite(
  host: string,
  slug: string | undefined,
  /*
   * A primitive, deliberately. React `cache` memoises on argument identity, so
   * an options OBJECT would be a fresh reference on every call and the memo
   * would never hit — measured: still two round trips per request.
   */
  preview = false,
): Promise<ResolvedSite | null> {
  /*
   * React `cache` on top of the Next cache, because this route resolves TWICE
   * per request — once in generateMetadata, once in the render — and those are
   * separate misses. Without it a cold request costs two round trips, and every
   * preview request costs two, since previews deliberately skip the Next cache
   * entirely. This dedupes within one request only; it holds nothing between
   * them.
   */
  const convex = convexClient();
  if (!convex) return null;

  const query = () => convex.query(api.public.site.resolve, { host, slug });

  if (preview) return query();

  const tags = [host ? hostTag(host) : null, slug ? slugTag(slug) : null].filter(
    (t): t is string => t !== null,
  );

  // Nothing identifies the tenant, so there is nothing to cache against and
  // nothing to serve. Let it through rather than caching one holding page
  // under an empty key for every unmatched host on the origin.
  if (tags.length === 0) return query();

  return unstable_cache(query, ["site-resolve", host, slug ?? ""], {
    tags,
    revalidate: FALLBACK_REVALIDATE_SECONDS,
  })();
});

/**
 * Legacy 301s from the site we replaced. Checked only for paths that would
 * otherwise 404, and cached under the slug so a redirect-map edit clears with
 * the same tag as the config that shipped it.
 */
export async function redirectFor(
  slug: string,
  path: string,
): Promise<{ to: string; statusCode: number } | null> {
  const convex = convexClient();
  if (!convex) return null;

  return unstable_cache(
    () => convex.query(api.public.site.redirectFor, { slug, path }),
    ["site-redirect", slug, path],
    { tags: [slugTag(slug)], revalidate: FALLBACK_REVALIDATE_SECONDS },
  )();
}
