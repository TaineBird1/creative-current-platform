import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { buildAccentRamp, solarTradesTemplate } from "@cc/site-config";
import { insertSite } from "./siteConfigs";

/**
 * Seeds ONE live client so the public site can be exercised end to end.
 *
 * `internalMutation`, so it is not reachable from a browser at any point.
 * Every row it creates carries `isSeed: true` — the dispatch layer refuses to
 * send real messages to seed data, and the revenue blocks key off the same
 * flag. Seed data that looks indistinguishable from real data is how you end
 * up WhatsApping a fictional customer.
 *
 *   npx convex run seed:solarClient
 */
export const solarClient = internalMutation({
  args: { slug: v.optional(v.string()), brandColour: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const slug = args.slug ?? "renu-solar";
    const brandColour = args.brandColour ?? "#f26a1b";

    const existing = await ctx.db
      .query("clients")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (existing) return { slug, clientId: existing._id, created: false };

    const venture =
      (await ctx.db.query("ventures").withIndex("by_active", (q) => q.eq("active", true)).first()) ??
      null;

    const ventureId =
      venture?._id ??
      (await ctx.db.insert("ventures", {
        name: "The Creative Current · Sites",
        type: "platform",
        currency: "ZAR",
        active: true,
        sortOrder: 1,
      }));

    const clientId = await ctx.db.insert("clients", {
      ventureId,
      kind: "platform",
      name: "Renu Solar",
      slug,
      status: "live",
      brandColour,
      timezone: "Africa/Johannesburg",
      currency: "ZAR",
      primaryContactName: "Taine",
      primaryContactPhone: "+27825551234",
      featureFlags: { quotes: true },
      isDemo: false,
      isSeed: true,
      goLiveAt: Date.now(),
    });

    await ctx.db.insert("locations", {
      clientId,
      name: "Renu Solar",
      addressLine: "12 Old Main Road",
      suburb: "Hillcrest",
      city: "Durban",
      region: "KwaZulu-Natal",
      countryCode: "ZA",
      phone: "+27315551234",
      whatsapp: "+27825551234",
      timezone: "Africa/Johannesburg",
      active: true,
    });

    const siteId = await insertSite(ctx, {
      clientId,
      slug,
      status: "live",
      isDemo: false,
      publish: true,
      config: solarTradesTemplate({
        businessName: "Renu Solar",
        slug,
        brandColour,
        accent: buildAccentRamp(brandColour),
        city: "Durban",
        region: "KwaZulu-Natal",
        suburb: "Hillcrest",
        addressLine: "12 Old Main Road",
        phone: "+27315551234",
        whatsapp: "+27825551234",
        email: "hello@renusolar.co.za",
      }),
    });

    return { slug, clientId, siteId, created: true };
  },
});

/** Reads back what the public site would see. `npx convex run seed:check` */
export const check = internalMutation({
  args: { slug: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const slug = args.slug ?? "renu-solar";
    const site = await ctx.db
      .query("sites")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    const requests = site
      ? await ctx.db
          .query("quoteRequests")
          .withIndex("by_site", (q) => q.eq("siteId", site._id))
          .collect()
      : [];
    return {
      site: site ? { slug: site.slug, status: site.status, published: Boolean(site.publishedConfig) } : null,
      quoteRequests: requests.map((r) => ({
        name: r.name,
        phone: r.phone,
        status: r.status,
        answers: r.answers,
        consentText: r.consentText.slice(0, 40),
        isDemo: r.isDemo,
      })),
    };
  },
});
