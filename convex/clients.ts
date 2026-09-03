import { v, ConvexError } from "convex/values";
import { byName } from "./lib/ordering";
import { ownerMutation, platformQuery, tenantQuery } from "./lib/functions";
import { safeParseSiteConfig } from "@cc/site-config";
import { currency } from "./tables/tenants";

/**
 * The client list, platform-side. Operating across every tenant is exactly
 * what the owner console is for, so this is a platformQuery and takes no
 * tenant argument at all.
 *
 * `ventureId` filters rather than scopes — it is a reporting lens for the
 * switcher, not a security boundary. Platform functions are already allowed
 * across every tenant; if this were a tenant function it would take a slug
 * and derive its own scope, which is the rule that has its own test.
 */
export const list = platformQuery({
  args: { ventureId: v.optional(v.id("ventures")) },
  handler: async (ctx, { ventureId }) => {
    const clients = ventureId
      ? await ctx.db
          .query("clients")
          .withIndex("by_venture", (q) => q.eq("ventureId", ventureId))
          .collect()
      : await ctx.db.query("clients").collect();

    const ventures = await ctx.db.query("ventures").collect();
    const ventureById = new Map(ventures.map((venture) => [venture._id, venture]));

    const rows = [];
    for (const client of clients) {
      const domains = await ctx.db
        .query("domains")
        .withIndex("by_client", (q) => q.eq("clientId", client._id))
        .collect();
      const venture = ventureById.get(client.ventureId);

      rows.push({
        _id: client._id,
        name: client.name,
        slug: client.slug ?? null,
        kind: client.kind,
        status: client.status,
        isSeed: client.isSeed,
        isDemo: client.isDemo,
        ventureId: client.ventureId,
        ventureName: venture?.name ?? null,
        ventureType: venture?.type ?? null,
        currency: client.currency,
        domainCount: domains.length,
        liveDomain: domains.find((d) => d.verificationStatus === "verified")?.hostname ?? null,
      });
    }
    return rows.sort(byName((row) => row.name));
  },
});

/**
 * EXTERNAL CLIENTS (Part 5.2) — the consulting and side work.
 *
 * An external client is a real client that is not a tenant. They get contact
 * details, a timeline, tasks, documents, and invoices through the SAME
 * invoice engine and ledger as everyone else. They do NOT get a public site,
 * a back office, a subscription, a slug or a feature set.
 *
 * That distinction is enforced here rather than trusted, because the failure
 * is quiet and expensive: a slug is what `app.<domain>/c/<slug>` resolves,
 * so an external client that acquired one would mint a back office nobody
 * intended, for a client who never bought one, reachable by anyone who
 * guessed the URL. Nothing downstream re-checks `kind` before serving it.
 */
export const createExternal = ownerMutation({
  args: {
    ventureId: v.id("ventures"),
    name: v.string(),
    legalName: v.optional(v.string()),
    currency,
    timezone: v.optional(v.string()),
    primaryContactName: v.optional(v.string()),
    primaryContactPhone: v.optional(v.string()),
    primaryContactEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) {
      throw new ConvexError({ code: "INVALID", message: "A client needs a name." });
    }

    const venture = await ctx.db.get(args.ventureId);
    if (!venture) {
      throw new ConvexError({ code: "NO_SUCH_VENTURE", message: "No such venture." });
    }
    if (!venture.active) {
      throw new ConvexError({
        code: "VENTURE_ARCHIVED",
        message: `"${venture.name}" is archived. Restore it before adding clients.`,
      });
    }

    const clientId = await ctx.db.insert("clients", {
      ventureId: args.ventureId,
      kind: "external",
      name,
      legalName: args.legalName?.trim() || undefined,
      /*
       * NO SLUG. Not "" and not a generated one — absent. The back office
       * resolves by slug, so the only safe value for a client who did not buy
       * one is nothing to resolve.
       */
      status: "live",
      timezone: args.timezone ?? "Africa/Johannesburg",
      currency: args.currency,
      primaryContactName: args.primaryContactName?.trim() || undefined,
      primaryContactPhone: args.primaryContactPhone?.trim() || undefined,
      primaryContactEmail: args.primaryContactEmail?.trim() || undefined,
      /*
       * Empty, not populated. Feature flags drive the client's own back
       * office, which an external client does not have. The Feature Manager
       * hides absent modules rather than locking them, so an empty record is
       * the correct "this does not apply" — a populated one would render a
       * console for a client with nowhere to sign in.
       */
      featureFlags: {},
      isDemo: false,
      isSeed: false,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      action: "client.createExternal",
      entityTable: "clients",
      entityId: clientId,
      ventureId: args.ventureId,
      clientId,
      after: { name, kind: "external", venture: venture.name, currency: args.currency },
      at: Date.now(),
    });

    return { clientId, name, ventureId: args.ventureId };
  },
});


/**
 * A CLIENT'S OWN BRAND, FOR A CALLER WHO IS ALREADY INSIDE.
 *
 * This replaces `public/brand.forSignIn`, which was UNAUTHENTICATED and is
 * now deleted. That function answered "does this slug belong to a Creative
 * Current client, and what are they called" to anybody who asked, which made
 * the office origin an enumeration oracle: run a wordlist of KZN solar
 * installers against it and you have the client roster.
 *
 * The per-item disclosure was fine and the old comment said so honestly — a
 * client's name and brand colour are already on their public website. The
 * aggregate is the problem, and it is a different problem: the LIST of who
 * pays us is precisely the asset the outreach engine exists to build, and it
 * was readable by a stranger one HTTP request at a time.
 *
 * So the brand is tenant-scoped now. `tenantQuery` re-derives the caller's
 * membership from their own rows, so an unknown slug and a slug you have no
 * membership for are indistinguishable — which is the same answer the rest of
 * the tenant surface gives.
 *
 * "staff" tier: everyone who can open the back office sees its branding.
 */
export type ClientBrand = {
  name: string;
  colour: string | null;
  accent: unknown | null;
};

export const brand = tenantQuery("staff")({
  args: {},
  handler: async (ctx): Promise<ClientBrand> => {
    const client = await ctx.db.get(ctx.tenant.clientId);
    if (!client) throw new ConvexError({ code: "NOT_FOUND", message: "Not found" });

    const site = await ctx.db
      .query("sites")
      .withIndex("by_client", (q) => q.eq("clientId", ctx.tenant.clientId))
      .first();

    const parsed = site?.publishedConfig ? safeParseSiteConfig(site.publishedConfig) : null;

    return {
      name: client.name,
      colour: client.brandColour ?? null,
      accent: parsed?.success ? parsed.data.brand.accent : null,
    };
  },
});
