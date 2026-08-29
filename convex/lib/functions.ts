import { v } from "convex/values";
import {
  customQuery,
  customMutation,
  customAction,
  customCtx,
} from "convex-helpers/server/customFunctions";
import { makeFunctionReference } from "convex/server";
import { query, mutation, action } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  requireTenant,
  requirePlatform,
  assertWritable,
  type TenantContext,
  type TenantRole,
  type PlatformRole,
} from "./tenancy";

/**
 * The ONLY four constructors a feature module may use.
 *
 * `query` / `mutation` from _generated/server are reserved for the four
 * public modules in the allowlist (site rendering, public booking, webhooks,
 * auth). Everything else uses one of these. `noUnguardedFunctions.test.ts`
 * fails CI if that is ever violated.
 *
 * Note what tenantQuery does to the signature: it CONSUMES `clientSlug` and
 * hands the handler a `tenant` on ctx. The handler has no way to widen its
 * own scope, because it never sees an untrusted clientId at all.
 */

const tenantArgs = { clientSlug: v.string() };

export function tenantQuery(minRole: TenantRole = "staff") {
  return customQuery(query, {
    args: tenantArgs,
    input: async (ctx, { clientSlug }) => {
      const tenant = await requireTenant(ctx, clientSlug, minRole);
      return { ctx: { ...ctx, tenant }, args: {} };
    },
  });
}

export function tenantMutation(minRole: TenantRole = "staff") {
  return customMutation(mutation, {
    args: tenantArgs,
    input: async (ctx, { clientSlug }) => {
      const tenant = await requireTenant(ctx, clientSlug, minRole);
      assertWritable(tenant); // read-only impersonation cannot write
      return { ctx: { ...ctx, tenant }, args: {} };
    },
  });
}

export const platformQuery = customQuery(
  query,
  customCtx(async (ctx) => ({ platform: await requirePlatform(ctx, "operator") })),
);

export const platformMutation = customMutation(
  mutation,
  customCtx(async (ctx) => ({ platform: await requirePlatform(ctx, "operator") })),
);

export const ownerQuery = customQuery(
  query,
  customCtx(async (ctx) => ({ platform: await requirePlatform(ctx, "owner") })),
);

export const ownerMutation = customMutation(
  mutation,
  customCtx(async (ctx) => ({ platform: await requirePlatform(ctx, "owner") })),
);

/**
 * Actions reach the network, so they cannot be guarded the way queries and
 * mutations are — there is no ctx.db to read memberships from. They DO carry
 * the caller's identity into runQuery, so the check is delegated there.
 *
 * Every action in this codebase must use this. A bare `action()` is a public,
 * unauthenticated endpoint; guards.test.ts fails on one.
 */
/**
 * Referenced by PATH rather than through `internal`, deliberately.
 *
 * Importing the generated api here creates a true cycle: this module is
 * imported by every function module, and the api type is built from all of
 * them. TypeScript resolves that to `any` and silently un-types every action
 * in the codebase rather than erroring where the cycle is.
 */
const requireCaller = makeFunctionReference<
  "query",
  Record<string, never>,
  { userId: Id<"users">; role: PlatformRole }
>("platform:requireCaller");

export const platformAction = customAction(
  action,
  customCtx(async (ctx) => ({ platform: await ctx.runQuery(requireCaller, {}) })),
);

export type TenantQueryCtx = { tenant: TenantContext };
