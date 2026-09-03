import { v, ConvexError } from "convex/values";
import { platformMutation, platformQuery } from "./lib/functions";
import type { MutationCtx } from "./_generated/server";
import { solarTradesTemplate, buildAccentRamp, safeParseSiteConfig } from "@cc/site-config";
import { contactDecision } from "./lib/suppression";
import { patchDoc } from "./lib/db";

/**
 * THE DEMO PIPELINE — a lead becomes a site you can send them.
 *
 * WHAT THIS DOES NOT DO: send anything. There is no WhatsApp driver and most
 * of these leads have a phone and no email, so the realistic delivery is the
 * owner pasting a link into WhatsApp himself, during or just after the call
 * that earned it. This produces the link. Automating the send would mean
 * building a channel nobody can use yet, on top of a consent regime that
 * cannot receive a STOP.
 *
 * WHAT A DEMO IS. A working site carrying a real business's name and suburb.
 * Every guarantee that keeps it from being an impersonation is already
 * enforced elsewhere and this file's job is to satisfy them rather than
 * restate them:
 *
 *   public/site.ts   refuses to serve a demo with no expiry, or past it
 *   SiteRenderer     throws rather than draw one without its disclosure
 *   demo-safety.ts   rewrites the link preview, withholds LocalBusiness
 *   robots/sitemap   deny and exclude
 *
 * WHAT IS NOT INVENTED. The address. A directory listing gives a suburb, not
 * a street, and printing a made-up street under a real business's name is
 * precisely the harm the demo rules exist for — so `addressLine` is absent
 * and the config schema allows that. Nor is a phone number invented: the
 * demo shows theirs, which is the one on the listing they already publish.
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

/** Thirty days. The same figure the resolver enforces; stated once, here. */
const DEMO_DAYS = 30;

/**
 * A slug from the business name, made unique.
 *
 * The name is theirs, so the slug is theirs — `upper-highway-solar` is what a
 * prospect expects to see in the link, and a random one reads as spam in a
 * WhatsApp message from a stranger.
 */
async function uniqueSlug(ctx: MutationCtx, businessName: string): Promise<string> {
  const base =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "demo";

  for (let attempt = 0; attempt < 50; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await ctx.db
      .query("sites")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!taken) return slug;
  }
  throw bad("SLUG_EXHAUSTED", `Could not find a free slug for "${businessName}".`);
}

/**
 * Build a demo for a lead.
 *
 * Creates the demo CLIENT and the demo SITE together. The client is marked
 * `isDemo`, which is what stops it ever accruing money — lib/ledger.ts and
 * lib/messaging.ts both refuse demo rows, so a demo cannot be invoiced and
 * cannot be messaged, whatever anyone later wires up.
 */
export const createForLead = platformMutation({
  args: {
    leadId: v.id("leads"),
    /** Their brand colour if you have it; otherwise a neutral trades green. */
    brandColour: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw bad("NOT_FOUND", "No such lead.");

    /*
     * A demo is outreach. Building one for a business that asked not to be
     * contacted is the same act as calling them, so it goes through the same
     * check — and fails closed for the same reason.
     */
    const verdict = await contactDecision(ctx, {
      placeId: lead.placeId,
      phone: lead.phone ?? null,
      domain: lead.website ?? null,
      businessName: lead.businessName,
    });
    if (verdict.blocked) {
      throw bad("SUPPRESSED", `${lead.businessName}: ${verdict.reason}`);
    }

    const existing = await ctx.db
      .query("sites")
      .filter((q) => q.eq(q.field("leadId"), args.leadId))
      .first();
    if (existing) {
      throw bad(
        "DEMO_EXISTS",
        `${lead.businessName} already has a demo at /${existing.slug}. Extend it or revoke it rather than making a second one.`,
      );
    }

    const slug = await uniqueSlug(ctx, lead.businessName);
    const brandColour = args.brandColour ?? "#1f6f43";
    const area = lead.area?.trim() || "KwaZulu-Natal";

    const config = solarTradesTemplate({
      businessName: lead.businessName,
      slug,
      brandColour,
      accent: buildAccentRamp(brandColour),
      city: "Durban",
      region: "KwaZulu-Natal",
      suburb: area,
      /*
       * NO addressLine. We know the suburb from a directory listing and not
       * the street, and inventing one puts a false address under a real
       * business's name. See the module note.
       */
      phone: lead.phone ?? "+27000000000",
    });

    /*
     * Parsed before it is stored, exactly as siteConfigs does for a real
     * site. A template change that produces an invalid config should fail
     * here, loudly, rather than at render time on a page a prospect opened.
     */
    const parsed = safeParseSiteConfig(config);
    if (!parsed.success) {
      throw bad(
        "INVALID_CONFIG",
        `The generated demo did not validate: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    const clientId = await ctx.db.insert("clients", {
      ventureId: lead.ventureId,
      kind: "platform",
      name: lead.businessName,
      slug,
      status: "prospect",
      timezone: "Africa/Johannesburg",
      currency: "ZAR",
      featureFlags: {},
      /* The flag every money and messaging path checks. */
      isDemo: true,
      isSeed: false,
    });

    const siteId = await ctx.db.insert("sites", {
      clientId,
      slug,
      status: "demo",
      config: parsed.data,
      publishedConfig: parsed.data,
      version: 1,
      configSchemaVersion: 1,
      /*
       * SET HERE, ALWAYS. The resolver refuses to serve a demo without one,
       * so a demo created without an expiry is not a leak — it is a page that
       * never loads. Which is the correct failure, and still a bug.
       */
      demoExpiresAt: now + DEMO_DAYS * 24 * 60 * 60 * 1000,
      leadId: args.leadId,
      isDemo: true,
    });

    await patchDoc(ctx, args.leadId, { status: "demo_sent" });

    return {
      siteId,
      clientId,
      slug,
      expiresAt: now + DEMO_DAYS * 24 * 60 * 60 * 1000,
      /** Paste this into the message. The path only — the host is per-deploy. */
      path: `/${slug}`,
    };
  },
});

/**
 * Give a demo longer.
 *
 * Extends from TODAY rather than from the old expiry, because that is what
 * the request means: a prospect who asks for another week on the last day
 * wants a week, not a week from when it was made.
 */
export const extend = platformMutation({
  args: { siteId: v.id("sites"), days: v.optional(v.number()), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const site = await ctx.db.get(args.siteId);
    if (!site) throw bad("NOT_FOUND", "No such site.");
    if (!site.isDemo) throw bad("NOT_A_DEMO", "That is a real client's site.");

    const days = args.days ?? DEMO_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw bad("INVALID", "Extend a demo by 1 to 90 days.");
    }

    const expiresAt = (args.now ?? Date.now()) + days * 24 * 60 * 60 * 1000;
    await patchDoc(ctx, args.siteId, { demoExpiresAt: expiresAt });
    return { expiresAt };
  },
});

/**
 * Take a demo down now.
 *
 * Sets the expiry to the past rather than deleting the site. The slug stays
 * claimed, so a link already sent resolves to the expired notice instead of
 * 404ing or — far worse — being handed to a different business later.
 */
export const revoke = platformMutation({
  args: { siteId: v.id("sites"), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const site = await ctx.db.get(args.siteId);
    if (!site) throw bad("NOT_FOUND", "No such site.");
    if (!site.isDemo) throw bad("NOT_A_DEMO", "That is a real client's site.");
    await patchDoc(ctx, args.siteId, { demoExpiresAt: (args.now ?? Date.now()) - 1000 });
    return { ok: true as const };
  },
});

/**
 * Every demo, with how long it has left and whether they looked.
 *
 * `expiresInDays` is negative once expired rather than clamped at zero: "went
 * dark 6 days ago" and "expires today" are different situations and only one
 * of them needs a call.
 */
export const list = platformQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const sites = (await ctx.db.query("sites").collect()).filter((site) => site.isDemo);

    const rows = await Promise.all(
      sites.map(async (site) => {
        const lead = site.leadId ? await ctx.db.get(site.leadId) : null;
        const engagements = site.leadId
          ? (await ctx.db.query("demoEngagements").collect()).filter(
              (row) => row.siteId === site._id,
            )
          : [];

        const expiresAt = site.demoExpiresAt ?? 0;
        return {
          siteId: site._id,
          slug: site.slug,
          path: `/${site.slug}`,
          businessName: lead?.businessName ?? site.slug,
          leadId: site.leadId ?? null,
          phone: lead?.phone ?? null,
          expiresAt,
          expiresInDays: Math.floor((expiresAt - now) / (24 * 60 * 60 * 1000)),
          expired: expiresAt <= now,
          /** Did they open it, and did they use the form. The buying signal. */
          engagements: engagements.length,
          lastEngagementAt:
            engagements.length > 0 ? Math.max(...engagements.map((row) => row.at)) : null,
        };
      }),
    );

    /*
     * Soonest to expire first — that is the one needing a call today. Tied
     * expiries break on the slug, which is unique and stable, so the list
     * cannot reshuffle between two refreshes.
     */
    return rows.sort((a, b) => a.expiresAt - b.expiresAt || a.slug.localeCompare(b.slug));
  },
});
