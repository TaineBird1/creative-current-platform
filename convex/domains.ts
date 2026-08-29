import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { platformAction, platformMutation, platformQuery } from "./lib/functions";
import { normaliseHostname, requiredRecords, dnsOnePager } from "./lib/dns";
import { attachDomain, domainStatus, isVercelConfigured } from "./lib/vercel";
import type { DomainAttachment, DomainStatus } from "./lib/vercel";

/**
 * THE DOMAIN WIZARD.
 *
 * Platform-side only. Go-live is a gated step the operator runs during
 * onboarding, not something a client does to themselves — and a client who
 * could claim an arbitrary hostname could claim someone else's.
 *
 * That last point is the security property here. `domains.by_hostname` is the
 * FIRST hop of tenant resolution on the public app: whoever holds a hostname
 * row decides what a request to that host renders. So a hostname is claimed
 * at most once, ever, and claiming one already held by another tenant is
 * refused rather than overwritten.
 */

const conflict = (message: string) => new ConvexError({ code: "CONFLICT", message });

/** Everything the wizard needs to show for one client. */
export const forClient = platformQuery({
  args: { clientId: v.id("clients") },
  handler: async (ctx, { clientId }) => {
    const client = await ctx.db.get(clientId);
    if (!client) throw new ConvexError({ code: "NOT_FOUND", message: "Not found" });

    const site = await ctx.db
      .query("sites")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .first();

    const domains = await ctx.db
      .query("domains")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();

    return {
      client: { name: client.name, slug: client.slug, status: client.status },
      hasSite: Boolean(site),
      sitePublished: Boolean(site?.publishedConfig),
      vercelConfigured: isVercelConfigured(),
      domains: domains.map((d) => ({
        _id: d._id,
        hostname: d.hostname,
        isPrimary: d.isPrimary,
        verificationStatus: d.verificationStatus,
        sslStatus: d.sslStatus,
        lastCheckedAt: d.lastCheckedAt,
        records: requiredRecords(d.hostname),
        onePager: dnsOnePager({
          hostname: d.hostname,
          businessName: client.name,
          records: requiredRecords(d.hostname),
        }),
      })),
    };
  },
});

/** Preview the instructions before claiming anything. No writes. */
export const preview = platformQuery({
  args: { hostname: v.string(), businessName: v.string() },
  handler: async (_ctx, { hostname, businessName }) => {
    const normalised = normaliseHostname(hostname);
    const records = requiredRecords(normalised);
    return {
      hostname: normalised,
      records,
      onePager: dnsOnePager({ hostname: normalised, businessName, records }),
    };
  },
});

/**
 * Claim a hostname for a client. Refuses if anyone already holds it.
 *
 * Separate from the Vercel call on purpose: the claim is a transaction and
 * must not depend on a third party being reachable. The action attaches
 * upstream afterwards.
 */
export const claim = platformMutation({
  args: { clientId: v.id("clients"), hostname: v.string(), isPrimary: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const hostname = normaliseHostname(args.hostname);

    const client = await ctx.db.get(args.clientId);
    if (!client) throw new ConvexError({ code: "NOT_FOUND", message: "Not found" });

    const site = await ctx.db
      .query("sites")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .first();
    if (!site) {
      throw conflict("This client has no site yet. Create the site before the domain.");
    }

    // The whole invariant, in one read. A hostname routes requests, so a
    // second claim on it is an attempt to serve someone else's traffic —
    // even when it is our own operator making an honest mistake.
    const existing = await ctx.db
      .query("domains")
      .withIndex("by_hostname", (q) => q.eq("hostname", hostname))
      .unique();

    if (existing) {
      if (existing.clientId === args.clientId) return { domainId: existing._id, created: false };
      throw conflict(`${hostname} is already attached to another client.`);
    }

    const isPrimary =
      args.isPrimary ??
      (await ctx.db
        .query("domains")
        .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
        .first()) === null;

    const domainId = await ctx.db.insert("domains", {
      siteId: site._id,
      clientId: args.clientId,
      hostname,
      isPrimary,
      verificationStatus: "pending",
      sslStatus: "pending",
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      clientId: args.clientId,
      ventureId: client.ventureId,
      action: "domain.claim",
      entityTable: "domains",
      entityId: domainId,
      after: { hostname, isPrimary },
      at: Date.now(),
    });

    return { domainId, created: true };
  },
});

export const release = platformMutation({
  args: { domainId: v.id("domains") },
  handler: async (ctx, { domainId }) => {
    const domain = await ctx.db.get(domainId);
    if (!domain) throw new ConvexError({ code: "NOT_FOUND", message: "Not found" });

    const client = await ctx.db.get(domain.clientId);
    await ctx.db.delete(domainId);

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      clientId: domain.clientId,
      ventureId: client?.ventureId,
      action: "domain.release",
      entityTable: "domains",
      entityId: domainId,
      before: { hostname: domain.hostname },
      at: Date.now(),
    });
  },
});

/* ---------------- the parts that talk to Vercel ---------------- */

export const recordStatus = internalMutation({
  args: {
    domainId: v.id("domains"),
    verified: v.boolean(),
    attached: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.domainId, {
      verificationStatus: args.verified ? "verified" : "pending",
      // Vercel issues the certificate once verification passes; there is no
      // separate step to wait on.
      sslStatus: args.verified ? "issued" : "pending",
      lastCheckedAt: Date.now(),
    });
  },
});

export const getDomain = internalQuery({
  args: { domainId: v.id("domains") },
  handler: async (ctx, { domainId }) => ctx.db.get(domainId),
});

/**
 * Attach upstream and record what came back.
 *
 * An action, because it reaches the network. It is safe to re-run: Vercel
 * treats an existing attachment to this project as success, and so does this.
 *
 * The return type is DECLARED. An action that calls another function in its
 * own module is circular by construction — the module's type depends on the
 * api, and the api depends on the module — and TypeScript resolves that to
 * `any` rather than erroring at the definition.
 */
export const attach = platformAction({
  args: { domainId: v.id("domains") },
  handler: async (ctx, { domainId }): Promise<DomainAttachment> => {
    const domain = await ctx.runQuery(internal.domains.getDomain, { domainId });
    if (!domain) throw new ConvexError({ code: "NOT_FOUND", message: "Not found" });

    const result = await attachDomain(domain.hostname);

    await ctx.runMutation(internal.domains.recordStatus, {
      domainId,
      verified: result.verified,
      attached: result.attached,
    });

    return result;
  },
});

/** Poll Vercel and update the stored status. The wizard's refresh button. */
export const refresh = platformAction({
  args: { domainId: v.id("domains") },
  handler: async (ctx, { domainId }): Promise<DomainStatus> => {
    const domain = await ctx.runQuery(internal.domains.getDomain, { domainId });
    if (!domain) throw new ConvexError({ code: "NOT_FOUND", message: "Not found" });

    const status = await domainStatus(domain.hostname);

    await ctx.runMutation(internal.domains.recordStatus, {
      domainId,
      verified: status.verified,
      attached: status.attached,
    });

    return status;
  },
});
