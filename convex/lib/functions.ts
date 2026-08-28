import { v } from "convex/values";
import {
  customQuery,
  customMutation,
  customCtx,
} from "convex-helpers/server/customFunctions";
import { query, mutation } from "../_generated/server";
import {
  requireTenant,
  requirePlatform,
  assertWritable,
  type TenantContext,
  type TenantRole,
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

export type TenantQueryCtx = { tenant: TenantContext };
