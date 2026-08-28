import { v, ConvexError } from "convex/values";
import { mutation } from "../_generated/server";
import { safeParseSiteConfig } from "@cc/site-config";

/**
 * PUBLIC, UNAUTHENTICATED. On the PUBLIC_ALLOWLIST in guards.test.ts.
 *
 * The quote flow for template #1 (solar/trades). Zero friction: name and
 * phone are the only required fields, and there is no end-customer account
 * anywhere in this file.
 *
 * The tenant is NOT taken from the request. It is derived from the site the
 * form was rendered on: slug -> site -> site.clientId. A caller who forges a
 * slug can only ever submit a lead into the site whose form they are looking
 * at, which is what the form is for.
 */

const rejected = (message: string) => new ConvexError({ code: "REJECTED", message });

export const submit = mutation({
  args: {
    slug: v.string(),
    sectionId: v.string(),
    name: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    answers: v.record(v.string(), v.string()),
    photoStorageIds: v.optional(v.array(v.id("_storage"))),
    consentAccepted: v.boolean(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.consentAccepted) throw rejected("consent is required");
    if (args.name.trim().length < 2) throw rejected("name is required");
    if (!/^\+?[0-9 ()-]{7,20}$/.test(args.phone)) throw rejected("a valid phone is required");

    const site = await ctx.db
      .query("sites")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!site) throw rejected("unknown site");
    if (site.status === "archived") throw rejected("site is not accepting submissions");

    const parsed = safeParseSiteConfig(site.publishedConfig ?? site.config);
    if (!parsed.success) throw rejected("site is not accepting submissions");

    const section = parsed.data.sections.find(
      (s) => s.id === args.sectionId && s.type === "quote",
    );
    if (!section || section.type !== "quote") throw rejected("unknown form");

    // Required fields come from the CONFIG, not from the browser's idea of them.
    for (const field of section.fields) {
      if (field.required && !args.answers[field.key]?.trim()) {
        throw rejected(`${field.label} is required`);
      }
    }
    // Silently drop answers to fields the section does not declare.
    const answers: Record<string, string> = {};
    for (const field of section.fields) {
      const value = args.answers[field.key];
      if (value !== undefined) answers[field.key] = value.slice(0, 2000);
    }

    const requestId = await ctx.db.insert("quoteRequests", {
      clientId: site.clientId,
      siteId: site._id,
      name: args.name.trim(),
      phone: args.phone.trim(),
      email: args.email?.trim(),
      answers,
      photoStorageIds: args.photoStorageIds ?? [],
      status: "new",
      consentText: section.consentText,
      lawfulBasis: "consent",
      submittedAt: Date.now(),
      userAgent: args.userAgent?.slice(0, 300),
      // A demo site produces demo submissions. They are never real leads and
      // the dispatch layer refuses to message them.
      isDemo: site.isDemo || site.status === "demo",
    });

    // Demo engagement lands on the LEAD, not on a tenant.
    if (site.isDemo && site.leadId) {
      await ctx.db.insert("demoEngagements", {
        siteId: site._id,
        leadId: site.leadId,
        kind: "quote_tested",
        at: Date.now(),
      });
    }

    return { ok: true as const, requestId };
  },
});
