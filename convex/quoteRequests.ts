import { v } from "convex/values";
import { tenantQuery, tenantMutation } from "./lib/functions";
import { assertOwned, auditWrite } from "./lib/tenancy";

/**
 * The one authenticated tenant module M1 needs: someone has to read the quote
 * requests the public form produces. Every other tenant module (calendar,
 * CRM, invoicing) is M3+ and deliberately absent.
 *
 * This is also the reference shape. Every scoped module that follows it:
 *   - is built with tenantQuery/tenantMutation, never bare query/mutation
 *   - starts reads from ctx.tenant.clientId, never from args
 *   - passes anything fetched by id through assertOwned
 */

export const list = tenantQuery("staff")({
  args: {
    status: v.optional(
      v.union(
        v.literal("new"),
        v.literal("contacted"),
        v.literal("quoted"),
        v.literal("won"),
        v.literal("lost"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { status, limit }) => {
    const take = Math.min(limit ?? 50, 200);

    const rows = status
      ? await ctx.db
          .query("quoteRequests")
          .withIndex("by_client_status", (q) =>
            q.eq("clientId", ctx.tenant.clientId).eq("status", status),
          )
          .order("desc")
          .take(take)
      : await ctx.db
          .query("quoteRequests")
          .withIndex("by_client_submitted", (q) => q.eq("clientId", ctx.tenant.clientId))
          .order("desc")
          .take(take);

    // Staff see that work exists; they do not see the customer's contact
    // details. Row-scoping happens here, at the query layer, not in the UI.
    if (ctx.tenant.role === "staff") {
      return rows.map(({ phone: _p, email: _e, ...rest }) => ({
        ...rest,
        phone: null,
        email: null,
      }));
    }
    return rows;
  },
});

export const get = tenantQuery("manager")({
  args: { requestId: v.id("quoteRequests") },
  handler: async (ctx, { requestId }) => {
    // An id from the browser is a SELECTOR, never an authorisation.
    return assertOwned(ctx.tenant, await ctx.db.get(requestId));
  },
});

export const setStatus = tenantMutation("manager")({
  args: {
    requestId: v.id("quoteRequests"),
    status: v.union(
      v.literal("new"),
      v.literal("contacted"),
      v.literal("quoted"),
      v.literal("won"),
      v.literal("lost"),
    ),
  },
  handler: async (ctx, { requestId, status }) => {
    const request = assertOwned(ctx.tenant, await ctx.db.get(requestId));
    await ctx.db.patch(requestId, { status });
    await auditWrite(ctx, ctx.tenant, {
      action: "quoteRequest.setStatus",
      entityTable: "quoteRequests",
      entityId: requestId,
      before: { status: request.status },
      after: { status },
    });
  },
});
