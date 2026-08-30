import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * PUSH-SIDE OF THE SITES CACHE.
 *
 * `apps/sites` does not query Convex per pageview — it caches resolution and
 * relies on being told when a site changes. This is the telling. Anything that
 * alters what a public visitor would see (config replace, publish, domain
 * change, redirect map edit) schedules `revalidateSite`, which POSTs the
 * affected cache tags to the sites app.
 *
 * Two properties that matter more than the feature:
 *
 * 1. It NEVER fails a write. Revalidation runs in a scheduled action, after
 *    the mutation has committed, and swallows its own errors. A publish that
 *    succeeded must not report failure because a cache hook was unreachable —
 *    the site is correct, it is just briefly stale, and the fallback
 *    `revalidate` in site-cache.ts closes that window on its own.
 * 2. It is not configured in dev by default, and that is fine. Unset env vars
 *    log once and return; they do not throw.
 *
 * Tag shape is the contract with `apps/sites/lib/site-cache.ts`:
 *   site:slug:<slug> · site:host:<hostname>
 */

const slugTag = (slug: string) => `site:slug:${slug.toLowerCase()}`;
const hostTag = (host: string) => `site:host:${host.toLowerCase()}`;

/**
 * Every tag a site is reachable by. A lookup by custom domain cannot know the
 * slug until it has already resolved, so the host tags have to be collected
 * here, where the domain rows are visible.
 */
export const tagsForSite = internalQuery({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }): Promise<string[]> => {
    const site = await ctx.db.get(siteId);
    if (!site) return [];

    const domains = await ctx.db
      .query("domains")
      .withIndex("by_site", (q) => q.eq("siteId", siteId))
      .collect();

    return [slugTag(site.slug), ...domains.map((d) => hostTag(d.hostname))];
  },
});

/**
 * Fire-and-forget. Schedule this from a mutation with
 * `ctx.scheduler.runAfter(0, internal.siteRevalidate.revalidateSite, { siteId })`.
 */
export const revalidateSite = internalAction({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }): Promise<void> => {
    const url = process.env.SITES_REVALIDATE_URL;
    const secret = process.env.REVALIDATE_SECRET;

    if (!url || !secret) {
      console.warn(
        "[revalidate] SITES_REVALIDATE_URL or REVALIDATE_SECRET unset; " +
          "public sites will go stale until the fallback window expires",
      );
      return;
    }

    const tags: string[] = await ctx.runQuery(internal.siteRevalidate.tagsForSite, {
      siteId: siteId as Id<"sites">,
    });
    if (tags.length === 0) return;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-revalidate-secret": secret },
        body: JSON.stringify({ tags }),
      });
      if (!response.ok) {
        // Loud, but not fatal. The write already committed.
        console.error(`[revalidate] ${response.status} from sites app for ${tags.join(", ")}`);
      }
    } catch (error) {
      console.error("[revalidate] could not reach the sites app", error);
    }
  },
});
