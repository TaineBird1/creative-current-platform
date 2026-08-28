import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";

/* ------------------------------------------------------------------ *
 * THE RULE
 *
 * A scoped function NEVER accepts an Id<"clients"> from the browser.
 * It accepts a SLUG, and resolves it by walking the caller's own
 * membership rows. The tenant is therefore derived from the authenticated
 * user in the literal sense: the only clientIds in play are ones that came
 * out of `memberships` for that userId.
 *
 * Consequence: an unknown slug and an unauthorised slug are indistinguishable
 * to the caller. Both raise NOT_FOUND. No tenant enumeration.
 * ------------------------------------------------------------------ */

export type TenantRole = "owner" | "manager" | "staff";
export type PlatformRole = "owner" | "operator" | "agent";

const TENANT_RANK: Record<TenantRole, number> = { staff: 1, manager: 2, owner: 3 };
const PLATFORM_RANK: Record<PlatformRole, number> = { agent: 1, operator: 2, owner: 3 };

export type TenantContext = {
  userId: Id<"users">;
  clientId: Id<"clients">;
  client: Doc<"clients">;
  role: TenantRole;
  /** Managers are pinned to one branch. Row-scoping must apply this. */
  locationId: Id<"locations"> | null;
  /** True when a platform user is acting as this tenant. */
  impersonating: boolean;
  impersonationSessionId: Id<"impersonationSessions"> | null;
  /** Read-only impersonation. Mutations refuse when this is true. */
  readOnly: boolean;
  /** Set when reached through a reseller membership rather than a direct one. */
  viaResellerId: Id<"clients"> | null;
  /** The client's CURRENT slug. Differs from the requested one on an alias hit. */
  canonicalSlug: string;
  /** True when the caller used a retired slug and should be 301'd to canonical. */
  viaAlias: boolean;
};

const notFound = () => new ConvexError({ code: "NOT_FOUND", message: "Not found" });
const forbidden = (need: string) =>
  new ConvexError({ code: "FORBIDDEN", message: `Requires ${need}` });

/**
 * Does this client answer to `slug`, either as its current slug or as one of
 * its retired aliases?
 *
 * Note the direction: we start from a client the caller already has a
 * membership on, and ask whether it answers to the requested slug. We never
 * go slug -> client, which would reintroduce the lookup-before-authorise hole
 * that the whole design exists to close.
 */
async function clientAnswersToSlug(
  ctx: QueryCtx,
  client: Doc<"clients">,
  slug: string,
): Promise<{ matched: true; viaAlias: boolean } | null> {
  if (client.slug === slug) return { matched: true, viaAlias: false };

  const aliases = await ctx.db
    .query("clientSlugAliases")
    .withIndex("by_client", (q) => q.eq("clientId", client._id))
    .collect();

  return aliases.some((a) => a.slug === slug) ? { matched: true, viaAlias: true } : null;
}

export async function requireUser(ctx: QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in required" });
  return userId;
}

/* ------------------------------ platform ------------------------------ */

export async function requirePlatform(
  ctx: QueryCtx,
  minRole: PlatformRole = "operator",
): Promise<{ userId: Id<"users">; role: PlatformRole }> {
  const userId = await requireUser(ctx);
  const member = await ctx.db
    .query("platformMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!member || !member.active) throw forbidden("platform access");
  if (PLATFORM_RANK[member.role] < PLATFORM_RANK[minRole]) throw forbidden(`platform:${minRole}`);
  return { userId, role: member.role };
}

/* ------------------------------- tenant ------------------------------- */

/**
 * Resolve `slug` to a tenant THROUGH the caller's memberships.
 *
 * Order matters and is the whole security property:
 *   1. list the caller's active memberships (keyed by userId)
 *   2. load only those clients
 *   3. pick the one whose slug matches
 * We never call clients.by_slug first. There is no code path where a
 * browser-supplied string selects a document before authorisation runs.
 */
export async function requireTenant(
  ctx: QueryCtx,
  slug: string,
  minRole: TenantRole = "staff",
): Promise<TenantContext> {
  const userId = await requireUser(ctx);

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId).eq("active", true))
    .collect();

  for (const m of memberships) {
    const client = await ctx.db.get(m.clientId);
    if (!client) continue;
    const hit = await clientAnswersToSlug(ctx, client, slug);
    if (!hit) continue;
    if (TENANT_RANK[m.role] < TENANT_RANK[minRole]) throw forbidden(`role:${minRole}`);
    return {
      userId,
      clientId: client._id,
      client,
      role: m.role,
      locationId: m.locationId ?? null,
      impersonating: false,
      impersonationSessionId: null,
      readOnly: false,
      viaResellerId: null,
      canonicalSlug: client.slug ?? slug,
      viaAlias: hit.viaAlias,
    };
  }

  // Reseller hop: a membership at an agency reaches that agency's own clients,
  // at structure tier only. The agency is capped at "manager" downstream --
  // it can change structure and theme, never the client's billing.
  const viaReseller = await resolveViaReseller(ctx, userId, memberships, slug);
  if (viaReseller) {
    if (TENANT_RANK[viaReseller.role] < TENANT_RANK[minRole]) throw forbidden(`role:${minRole}`);
    return viaReseller;
  }

  // Platform impersonation is the last resort, never the first.
  const impersonated = await resolveViaImpersonation(ctx, userId, slug);
  if (impersonated) {
    if (TENANT_RANK[impersonated.role] < TENANT_RANK[minRole]) throw forbidden(`role:${minRole}`);
    return impersonated;
  }

  throw notFound();
}

async function resolveViaReseller(
  ctx: QueryCtx,
  userId: Id<"users">,
  memberships: Doc<"memberships">[],
  slug: string,
): Promise<TenantContext | null> {
  for (const m of memberships) {
    if (m.role !== "owner") continue; // only an agency OWNER reaches downstream
    const downstream = await ctx.db
      .query("clients")
      .withIndex("by_reseller", (q) => q.eq("resellerId", m.clientId))
      .collect();
    for (const candidate of downstream) {
      const hit = await clientAnswersToSlug(ctx, candidate, slug);
      if (!hit) continue;
      return {
        userId,
        clientId: candidate._id,
        client: candidate,
        role: "manager",
        locationId: null,
        impersonating: false,
        impersonationSessionId: null,
        readOnly: false,
        viaResellerId: m.clientId,
        canonicalSlug: candidate.slug ?? slug,
        viaAlias: hit.viaAlias,
      };
    }
  }
  return null;
}

async function resolveViaImpersonation(
  ctx: QueryCtx,
  userId: Id<"users">,
  slug: string,
): Promise<TenantContext | null> {
  const platform = await ctx.db
    .query("platformMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!platform || !platform.active) return null;

  const sessions = await ctx.db
    .query("impersonationSessions")
    .withIndex("by_platformUser_active", (q) =>
      q.eq("platformUserId", userId).eq("endedAt", undefined),
    )
    .collect();

  const now = Date.now();
  for (const s of sessions) {
    if (s.expiresAt <= now) continue; // 60-minute ceiling, enforced on read
    const client = await ctx.db.get(s.clientId);
    if (!client) continue;
    const hit = await clientAnswersToSlug(ctx, client, slug);
    if (!hit) continue;
    return {
      userId,
      clientId: client._id,
      client,
      role: "owner",
      locationId: null,
      impersonating: true,
      impersonationSessionId: s._id,
      readOnly: s.mode === "read",
      viaResellerId: null,
      canonicalSlug: client.slug ?? slug,
      viaAlias: hit.viaAlias,
    };
  }
  return null;
}

/* ------------------------- row-level assertions ------------------------- */

/**
 * Every document fetched by id inside a scoped function goes through this.
 * Fetching by id is unavoidable (a booking's customer, a quote's job); this
 * is the choke point that stops one tenant's id from resolving under another.
 */
export function assertOwned<T extends { clientId: Id<"clients"> }>(
  tenant: TenantContext,
  doc: T | null,
): T {
  if (!doc || doc.clientId !== tenant.clientId) throw notFound();
  return doc;
}

/** Managers see one branch. Applied at the query layer, not in the UI. */
export function assertLocationAllowed(tenant: TenantContext, locationId: Id<"locations">) {
  if (tenant.role === "manager" && tenant.locationId && tenant.locationId !== locationId) {
    throw notFound();
  }
}

/** Read-only impersonation must not write. Called by every tenant mutation. */
export function assertWritable(tenant: TenantContext) {
  if (tenant.readOnly) throw forbidden("acting mode");
}

/** Real sends and real money are blocked against demo/seed tenants. */
export function assertNotDemo(tenant: TenantContext) {
  if (tenant.client.isDemo || tenant.client.isSeed) {
    throw new ConvexError({ code: "DEMO_BLOCKED", message: "Not permitted on demo data" });
  }
}

export async function auditWrite(
  ctx: MutationCtx,
  tenant: TenantContext,
  entry: {
    action: string;
    entityTable: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  },
) {
  await ctx.db.insert("auditLog", {
    actorUserId: tenant.userId,
    impersonationSessionId: tenant.impersonationSessionId ?? undefined,
    clientId: tenant.clientId,
    ventureId: tenant.client.ventureId,
    at: Date.now(),
    ...entry,
  });
}
