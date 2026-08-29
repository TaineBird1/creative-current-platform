import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
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

/**
 * Declared, not inferred.
 *
 * The custom function constructors in lib/functions.ts do not carry a
 * handler's return type through to the generated api, so every consumer sees
 * `any` — which silently removes type safety from exactly the screens that
 * render tenant data. Annotating the handler restores it.
 */
export type QuoteRequestRow = {
  _id: Id<"quoteRequests">;
  status: "new" | "contacted" | "quoted" | "won" | "lost";
  name: string;
  /** null for staff: contact details are owner-tier. */
  phone: string | null;
  email: string | null;
  answers: { key: string; value: string }[];
  submittedAt: number;
  isDemo: boolean;
};

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
  handler: async (ctx, { status, limit }): Promise<QuoteRequestRow[]> => {
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
    //
    // ONE shape either way, with phone and email nullable. Returning a union
    // instead pushes narrowing onto every consumer and, worse, widens the
    // other fields to `unknown` at the call site — which is how a render of
    // `answers` stopped type-checking.
    const withheld = ctx.tenant.role === "staff";
    return rows.map((row) => ({
      _id: row._id,
      status: row.status,
      name: row.name,
      phone: withheld ? null : row.phone,
      email: withheld ? null : (row.email ?? null),
      // An ORDERED array, not the raw record. Two reasons: the order a form
      // was answered in is meaningful and Object.entries does not promise it,
      // and a record's value type does not survive the serialisation boundary
      // intact — it arrives as unknown and every consumer has to cast.
      answers: Object.entries(row.answers).map(([key, value]) => ({
        key,
        value: String(value),
      })),
      submittedAt: row.submittedAt,
      isDemo: row.isDemo,
    }));
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
