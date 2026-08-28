import { v, ConvexError } from "convex/values";
import { parseSiteConfig, SITE_CONFIG_VERSION } from "@cc/site-config";
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
