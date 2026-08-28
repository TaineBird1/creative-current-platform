import { v } from "convex/values";
import { query } from "../_generated/server";
import { safeParseSiteConfig } from "@cc/site-config";
import type { Doc } from "../_generated/dataModel";

/**
 * PUBLIC, UNAUTHENTICATED. On the PUBLIC_ALLOWLIST in guards.test.ts.
 *
 * This is the one place a browser-supplied string legitimately selects a
 * document, because the thing it selects is a published website -- content
 * that is public by definition. Note what it returns: `publishedConfig` only,
 * never `config`, never the client row, never anything a tenant guard covers.
 *
 * Resolution order (Part 1): host -> custom domain -> slug -> ?site= preview.
 */

type Resolved =
  | { kind: "site"; slug: string; config: unknown; isDemo: boolean }
  | { kind: "redirect"; to: string }
  | { kind: "holding"; reason: "unknown" | "unpublished" | "expired" | "invalid" };

/**
 * An invalid or missing config renders a branded holding page. It NEVER falls
 * through to another tenant's content -- that is the failure mode this whole
 * function is shaped to avoid.
 */
function serve(site: Doc<"sites">): Resolved {
  if (site.status === "archived") return { kind: "holding", reason: "unpublished" };
  if (site.status === "demo" && site.demoExpiresAt && site.demoExpiresAt < Date.now()) {
    return { kind: "holding", reason: "expired" };
  }
  if (!site.publishedConfig) return { kind: "holding", reason: "unpublished" };

  // Parse on read as well as on write: a config written by an older deploy
  // must not crash the renderer, it must degrade to the holding page.
  const parsed = safeParseSiteConfig(site.publishedConfig);
  if (!parsed.success) return { kind: "holding", reason: "invalid" };

  return { kind: "site", slug: site.slug, config: parsed.data, isDemo: site.isDemo };
}

export const resolve = query({
  args: { host: v.optional(v.string()), slug: v.optional(v.string()) },
  handler: async (ctx, { host, slug }): Promise<Resolved> => {
    // 1. Custom domain.
    if (host) {
      const domain = await ctx.db
        .query("domains")
        .withIndex("by_hostname", (q) => q.eq("hostname", host.toLowerCase()))
        .unique();
      if (domain) {
        const site = await ctx.db.get(domain.siteId);
        if (!site) return { kind: "holding", reason: "unknown" };
        return serve(site);
      }
    }

    if (!slug) return { kind: "holding", reason: "unknown" };

    // 2. Live slug.
    const bySlug = await ctx.db
      .query("sites")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (bySlug) return serve(bySlug);

    // 3. Retired slug -> canonical redirect, so bookmarks and printed QR
    //    codes survive a rebrand.
    const alias = await ctx.db
      .query("clientSlugAliases")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (alias) {
      const client = await ctx.db.get(alias.clientId);
      if (client?.slug) return { kind: "redirect", to: client.slug };
    }

    return { kind: "holding", reason: "unknown" };
  },
});

/** Legacy 301s carried over from the site we replaced. */
export const redirectFor = query({
  args: { slug: v.string(), path: v.string() },
  handler: async (ctx, { slug, path }) => {
    const site = await ctx.db
      .query("sites")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!site) return null;
    const hit = await ctx.db
      .query("redirects")
      .withIndex("by_site_from", (q) => q.eq("siteId", site._id).eq("from", path))
      .unique();
    return hit ? { to: hit.to, statusCode: hit.statusCode } : null;
  },
});
