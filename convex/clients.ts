import { platformQuery } from "./lib/functions";

/**
 * The client list, platform-side. Operating across every tenant is exactly
 * what the owner console is for, so this is a platformQuery and takes no
 * tenant argument at all.
 */
export const list = platformQuery({
  args: {},
  handler: async (ctx) => {
    const clients = await ctx.db.query("clients").collect();
    const rows = [];
    for (const client of clients) {
      const domains = await ctx.db
        .query("domains")
        .withIndex("by_client", (q) => q.eq("clientId", client._id))
        .collect();
      rows.push({
        _id: client._id,
        name: client.name,
        slug: client.slug ?? null,
        kind: client.kind,
        status: client.status,
        isSeed: client.isSeed,
        domainCount: domains.length,
        liveDomain: domains.find((d) => d.verificationStatus === "verified")?.hostname ?? null,
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});
