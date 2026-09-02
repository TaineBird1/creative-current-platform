import { v, ConvexError } from "convex/values";
import { parseSiteConfig, SITE_CONFIG_VERSION } from "@cc/site-config";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { tenantMutation, tenantQuery } from "./lib/functions";
import { assertOwned, auditWrite } from "./lib/tenancy";

/**
 * THE ONLY WRITER OF THE `sites` TABLE.
 *
 * The config column is v.any() at the database layer, so Convex will happily
 * store rubbish. This file is what stops it: every insert and patch goes
 * through parseSiteConfig (Zod), and guards.test.ts fails CI if any other
 * file calls db.insert("sites") or db.patch on a site.
 *
 * Demo generation and real onboarding both call `replace` here. One compose
 * pipeline, no second path -- a demo that renders is a real site minus a
 * domain, which is the whole reason demos are trustworthy.
 */

const invalid = (issues: string) =>
  new ConvexError({ code: "INVALID_CONFIG", message: issues });

/**
 * The site-insert primitive. Lives here because guards.test.ts holds this file
 * as the ONLY writer of the sites table — the config column is v.any(), so
 * this Zod parse is the only thing standing between the database and rubbish.
 * Callers (onboarding, demo generation, seeding) come through here.
 */
export async function insertSite(
  ctx: MutationCtx,
  args: {
    clientId: Id<"clients">;
    slug: string;
    config: unknown;
    status: "draft" | "demo" | "live" | "archived";
    isDemo: boolean;
    publish?: boolean;
  },
) {
  const parsed = parseSiteConfig(args.config);
  return ctx.db.insert("sites", {
    clientId: args.clientId,
    slug: args.slug,
    status: args.status,
    config: parsed,
    publishedConfig: args.publish ? parsed : undefined,
    publishedAt: args.publish ? Date.now() : undefined,
    version: 1,
    configSchemaVersion: SITE_CONFIG_VERSION,
    isDemo: args.isDemo,
  });
}

/**
 * A DEMO BECOMES THE REAL SITE. It is not replaced by one.
 *
 * When a deal is won, the prospect has already SEEN a page — at a slug made
 * from their own business name, with their brand colour on it, and that URL
 * has been in a WhatsApp thread for two weeks. Creating a fresh site would
 * take a second slug (the first is occupied), so the address they were sold
 * on would quietly become someone else's, and the demo client would linger as
 * a duplicate of a business that is now a customer.
 *
 * So the demo IS the site, promoted. The config is untouched — this changes
 * only what the row CLAIMS about itself — which is also why it needs no Zod
 * parse and why it can live beside the writers that do.
 *
 * `demoExpiresAt` is CLEARED, and that is the load-bearing line. `public/site`
 * refuses to serve a site whose expiry has passed, and treats a missing expiry
 * on a demo as a refusal too. A promoted site that kept its expiry would go
 * dark thirty days after the client started paying.
 */
export async function promoteSiteToLive(
  ctx: MutationCtx,
  siteId: Id<"sites">,
): Promise<void> {
  const site = await ctx.db.get(siteId);
  if (!site) throw new ConvexError({ code: "NOT_FOUND", message: "No such site." });

  await ctx.db.patch(siteId, {
    status: "live",
    isDemo: false,
    demoExpiresAt: undefined,
    /*
     * Published from whatever the demo was showing. A client whose site went
     * live blank, because the config was only ever in `config` and never in
     * `publishedConfig`, is a worse first day than any amount of stale copy.
     */
    publishedConfig: site.publishedConfig ?? site.config,
    publishedAt: site.publishedAt ?? Date.now(),
  });
}

export const get = tenantQuery("staff")({
  args: {},
  handler: async (ctx) => {
    const site = await ctx.db
      .query("sites")
      .withIndex("by_client", (q) => q.eq("clientId", ctx.tenant.clientId))
      .first();
    return site ?? null;
  },
});

/** Structure-tier edit. Agency and owner only; the client tier edits content. */
export const replace = tenantMutation("manager")({
  args: { siteId: v.id("sites"), config: v.any(), expectedVersion: v.number() },
  handler: async (ctx, { siteId, config, expectedVersion }) => {
    const site = assertOwned(ctx.tenant, await ctx.db.get(siteId));

    // Optimistic concurrency: two editors in one back office is normal.
    if (site.version !== expectedVersion) {
      throw new ConvexError({
        code: "STALE_CONFIG",
        message: `site has moved on (v${site.version}, you sent v${expectedVersion})`,
      });
    }

    const parsed = parseSiteConfig(config);

    await ctx.db.patch(siteId, {
      config: parsed,
      version: site.version + 1,
      configSchemaVersion: SITE_CONFIG_VERSION,
    });
    await auditWrite(ctx, ctx.tenant, {
      action: "site.replace",
      entityTable: "sites",
      entityId: siteId,
      after: { version: site.version + 1 },
    });
    // apps/sites caches resolution, so a write has to push. Scheduled, so a
    // slow or unreachable sites app can never fail an editor's save.
    await ctx.scheduler.runAfter(0, internal.siteRevalidate.revalidateSite, { siteId });
    return { version: site.version + 1 };
  },
});

/**
 * Publish copies config -> publishedConfig. A site cannot go live with a
 * config that does not parse, so the gate is here rather than at render time.
 */
export const publish = tenantMutation("owner")({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const site = assertOwned(ctx.tenant, await ctx.db.get(siteId));
    const parsed = parseSiteConfig(site.config);

    await ctx.db.patch(siteId, {
      publishedConfig: parsed,
      publishedAt: Date.now(),
      publishedBy: ctx.tenant.userId,
      status: site.status === "draft" ? "live" : site.status,
    });
    await auditWrite(ctx, ctx.tenant, {
      action: "site.publish",
      entityTable: "sites",
      entityId: siteId,
      after: { version: site.version },
    });
    // The one that actually changes what a visitor sees.
    await ctx.scheduler.runAfter(0, internal.siteRevalidate.revalidateSite, { siteId });
  },
});

/** Dry-run validation for the editor, so it can show errors before saving. */
export const validate = tenantQuery("staff")({
  args: { config: v.any() },
  handler: async (_ctx, { config }) => {
    const result = (await import("@cc/site-config")).safeParseSiteConfig(config);
    if (result.success) return { ok: true as const, issues: [] };
    return {
      ok: false as const,
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  },
});

export { invalid };
