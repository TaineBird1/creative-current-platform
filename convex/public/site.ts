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

/**
 * A demo carries a REAL business's name, suburb and Google rating. Everything
 * the renderer needs to say so travels with the config, because a template
 * that has to remember to ask is a template that will one day forget.
 */
export type DemoContext = {
  /** The business the demo is ABOUT. Named in the disclosure, not implied. */
  subjectName: string;
  expiresAt: number;
};

type Resolved =
  | { kind: "site"; slug: string; config: unknown; isDemo: boolean; demo: DemoContext | null }
  | { kind: "redirect"; to: string }
  | {
      kind: "holding";
      reason: "unknown" | "unpublished" | "expired" | "invalid" | "demo_expired";
    };

/**
 * An invalid or missing config renders a branded holding page. It NEVER falls
 * through to another tenant's content -- that is the failure mode this whole
 * function is shaped to avoid.
 */
function serve(site: Doc<"sites">, now = Date.now()): Resolved {
  if (site.status === "archived") return { kind: "holding", reason: "unpublished" };

  /*
   * THE DEMO GATE. Keyed on `isDemo`, NOT on status — this previously read
   * `status === "demo"`, so a demo whose status had been moved to "live" or
   * left at "draft" skipped the expiry entirely and served indefinitely.
   *
   * A MISSING EXPIRY IS A REFUSAL. It previously read `&& site.demoExpiresAt`,
   * which means a demo created without one served forever: the fail-OPEN
   * shape, on the one page that carries somebody else's business name.
   *
   * What is at stake is not a stale page. A demo is a working site bearing a
   * real business's name, suburb and Google rating. Left up and indexable it
   * is a live impersonation of that business, ranking in their own name, and
   * that is a legal problem rather than a bug — so ambiguity resolves to not
   * serving it.
   */
  if (site.isDemo) {
    if (!site.demoExpiresAt) {
      return { kind: "holding", reason: "demo_expired" };
    }
    if (site.demoExpiresAt <= now) {
      return { kind: "holding", reason: "demo_expired" };
    }
  }

  if (!site.publishedConfig) return { kind: "holding", reason: "unpublished" };

  // Parse on read as well as on write: a config written by an older deploy
  // must not crash the renderer, it must degrade to the holding page.
  const parsed = safeParseSiteConfig(site.publishedConfig);
  if (!parsed.success) return { kind: "holding", reason: "invalid" };

  return {
    kind: "site",
    slug: site.slug,
    config: parsed.data,
    isDemo: site.isDemo,
    /*
     * Non-null for EVERY demo that reaches here, because the gate above
     * refuses the ones without an expiry. The renderer relies on that: it
     * treats a null `demo` on a demo site as a bug and refuses to render.
     */
    demo: site.isDemo
      ? { subjectName: parsed.data.brand.name, expiresAt: site.demoExpiresAt! }
      : null,
  };
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
