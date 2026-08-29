import { v } from "convex/values";
import { query } from "../_generated/server";
import { safeParseSiteConfig } from "@cc/site-config";

/**
 * PUBLIC, UNAUTHENTICATED. On the PUBLIC_ALLOWLIST in guards.test.ts.
 *
 * A tenant-branded login has to show the client's brand BEFORE anyone has
 * signed in, so this cannot be a guarded function. Note exactly what it
 * returns: name, colour, accent ramp. Nothing else — no status, no contacts,
 * no counts, no ids. Everything here already appears on that client's public
 * website, so it discloses nothing new.
 *
 * It does confirm a slug exists. That is unavoidable for a branded login and
 * harmless: the public site confirms the same thing.
 */
export const forSignIn = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const client = await ctx.db
      .query("clients")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!client || client.kind !== "platform") return null;

    const site = await ctx.db
      .query("sites")
      .withIndex("by_client", (q) => q.eq("clientId", client._id))
      .first();

    const parsed = site?.publishedConfig
      ? safeParseSiteConfig(site.publishedConfig)
      : null;

    return {
      name: client.name,
      colour: client.brandColour ?? null,
      accent: parsed?.success ? parsed.data.brand.accent : null,
    };
  },
});
