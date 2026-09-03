import { v, ConvexError } from "convex/values";
import { byDesc } from "./lib/ordering";
import type { Id } from "./_generated/dataModel";
import { tenantQuery, tenantMutation } from "./lib/functions";
import { assertOwned, assertLocationAllowed, auditWrite } from "./lib/tenancy";
import { assertCents, sumCents } from "./lib/money";
import { patchDoc } from "./lib/db";

/**
 * JOBS — multi-day work, as distinct from a booking.
 *
 * The boundary, restated here because getting it wrong is expensive:
 *
 *   A BOOKING reserves calendar time. Overlap-checked, buffered, ≤24h.
 *   A JOB does NOT reserve calendar time. It has `scheduledFor` and no end,
 *   no duration and no location-time index, so nothing overlap-checks it.
 *
 * That is deliberate rather than missing. A three-day install is one job with
 * a status, a crew, materials and photos; the hours a crew is actually on
 * site are BOOKINGS created against it. Trying to make the job itself hold
 * the calendar would need an end time and an index, and that is a schema
 * decision, not something to improvise in a handler. Until then this module
 * will not pretend a job blocks time — a lie there produces a double-booked
 * crew, and the person who discovers it is standing in a customer's driveway.
 *
 * Materials cost is summed with `sumCents`, which refuses a mixed-currency
 * array, so a job cannot quietly total parts bought in two currencies.
 */

export type JobRow = {
  _id: Id<"jobs">;
  status: "quoted" | "accepted" | "scheduled" | "in_progress" | "complete" | "cancelled";
  customerId: Id<"customers">;
  customerName: string;
  locationId: Id<"locations">;
  quoteId: Id<"quotes"> | null;
  quoteNumber: string | null;
  scheduledFor: number | null;
  crewUserIds: Id<"users">[];
  materials: { name: string; quantity: number; unitCostCents: number }[];
  materialsCostCents: number;
  currency: "ZAR" | "USD" | "EUR" | "GBP" | "NAD" | "BWP";
  photoCount: number;
};

/**
 * Which transitions are allowed. A pipeline that accepts any status from any
 * status is not a pipeline, and "complete" arriving before "scheduled" is how
 * a report claims work was done that was never dispatched.
 */
const NEXT: Record<JobRow["status"], readonly JobRow["status"][]> = {
  quoted: ["accepted", "cancelled"],
  accepted: ["scheduled", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["complete", "cancelled"],
  complete: [],
  cancelled: [],
};

function materialsCost(
  materials: readonly { unitCostCents: number; quantity: number }[],
  currency: JobRow["currency"],
): number {
  const lines = materials.map((m) => {
    assertCents(m.unitCostCents, "unitCostCents");
    if (!Number.isFinite(m.quantity) || m.quantity <= 0) {
      throw new ConvexError({
        code: "INVALID_QUANTITY",
        message: "A material needs a quantity greater than zero.",
      });
    }
    // Rounded per line, so the total equals the sum of the visible lines.
    return { amountCents: Math.round(m.unitCostCents * m.quantity), currency };
  });
  return lines.length === 0 ? 0 : sumCents(lines, currency);
}

export const list = tenantQuery("staff")({
  args: {
    status: v.optional(
      v.union(
        v.literal("quoted"),
        v.literal("accepted"),
        v.literal("scheduled"),
        v.literal("in_progress"),
        v.literal("complete"),
        v.literal("cancelled"),
      ),
    ),
  },
  handler: async (ctx, { status }): Promise<JobRow[]> => {
    const rows = status
      ? await ctx.db
          .query("jobs")
          .withIndex("by_client_status", (q) =>
            q.eq("clientId", ctx.tenant.clientId).eq("status", status),
          )
          .collect()
      : await ctx.db
          .query("jobs")
          .withIndex("by_client_status", (q) => q.eq("clientId", ctx.tenant.clientId))
          .collect();

    const customers = new Map(
      (
        await ctx.db
          .query("customers")
          .withIndex("by_client_phone", (q) => q.eq("clientId", ctx.tenant.clientId))
          .collect()
      ).map((doc) => [doc._id, doc]),
    );

    const out: JobRow[] = [];
    for (const row of rows) {
      const quote = row.quoteId ? await ctx.db.get(row.quoteId) : null;
      out.push({
        _id: row._id,
        status: row.status,
        customerId: row.customerId,
        customerName: customers.get(row.customerId)?.name ?? "Unknown customer",
        locationId: row.locationId,
        quoteId: row.quoteId ?? null,
        quoteNumber: quote?.number ?? null,
        scheduledFor: row.scheduledFor ?? null,
        crewUserIds: row.crewUserIds,
        materials: row.materials,
        materialsCostCents: materialsCost(row.materials, row.currency),
        currency: row.currency,
        photoCount: row.photoStorageIds.length,
      });
    }
    // Every UNSCHEDULED job shares the null, so ties here are the norm.
    return out.sort(byDesc((row) => row.scheduledFor ?? 0));
  },
});

export const create = tenantMutation("manager")({
  args: {
    customerId: v.id("customers"),
    locationId: v.id("locations"),
    quoteId: v.optional(v.id("quotes")),
    scheduledFor: v.optional(v.number()),
    crewUserIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args): Promise<{ jobId: Id<"jobs"> }> => {
    const customer = assertOwned(ctx.tenant, await ctx.db.get(args.customerId));
    const location = assertOwned(ctx.tenant, await ctx.db.get(args.locationId));
    assertLocationAllowed(ctx.tenant, location._id);

    if (customer.mergedIntoId) {
      throw new ConvexError({
        code: "CUSTOMER_MERGED",
        message: "That customer record was merged. Use the surviving record.",
      });
    }

    let status: JobRow["status"] = "accepted";
    if (args.quoteId) {
      const quote = assertOwned(ctx.tenant, await ctx.db.get(args.quoteId));
      /*
       * A job from a quote must be for the SAME customer. Otherwise the job
       * bills against one person and the accepted document names another,
       * and both records look internally consistent.
       */
      if (quote.customerId !== args.customerId) {
        throw new ConvexError({
          code: "QUOTE_CUSTOMER_MISMATCH",
          message: `${quote.number} was quoted to a different customer.`,
        });
      }
      status = quote.status === "accepted" ? "accepted" : "quoted";
    }

    const client = await ctx.db.get(ctx.tenant.clientId);
    if (!client) throw new ConvexError({ code: "NOT_FOUND", message: "No such client." });

    const jobId = await ctx.db.insert("jobs", {
      clientId: ctx.tenant.clientId,
      quoteId: args.quoteId,
      customerId: args.customerId,
      locationId: args.locationId,
      status: args.scheduledFor ? "scheduled" : status,
      scheduledFor: args.scheduledFor,
      crewUserIds: args.crewUserIds ?? [],
      photoStorageIds: [],
      materials: [],
      currency: client.currency,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "job.create",
      entityTable: "jobs",
      entityId: jobId,
      after: { customerId: args.customerId, quoteId: args.quoteId ?? null },
    });

    return { jobId };
  },
});

export const setStatus = tenantMutation("staff")({
  args: {
    jobId: v.id("jobs"),
    status: v.union(
      v.literal("quoted"),
      v.literal("accepted"),
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("complete"),
      v.literal("cancelled"),
    ),
  },
  handler: async (ctx, { jobId, status }): Promise<{ jobId: Id<"jobs"> }> => {
    const job = assertOwned(ctx.tenant, await ctx.db.get(jobId));

    if (job.status === status) return { jobId };

    if (!NEXT[job.status].includes(status)) {
      throw new ConvexError({
        code: "INVALID_TRANSITION",
        message: `A job cannot go from ${job.status} to ${status}.`,
      });
    }

    /*
     * Scheduling needs a date. "Scheduled" with no time is a job nobody is
     * going to, sitting in a column that says someone is.
     */
    if (status === "scheduled" && !job.scheduledFor) {
      throw new ConvexError({
        code: "NOT_SCHEDULED",
        message: "Set a date before marking it scheduled.",
      });
    }

    await patchDoc(ctx, jobId, { status });
    await auditWrite(ctx, ctx.tenant, {
      action: "job.setStatus",
      entityTable: "jobs",
      entityId: jobId,
      before: { status: job.status },
      after: { status },
    });

    return { jobId };
  },
});

export const schedule = tenantMutation("manager")({
  args: {
    jobId: v.id("jobs"),
    scheduledFor: v.number(),
    crewUserIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args): Promise<{ jobId: Id<"jobs">; scheduledFor: number }> => {
    const job = assertOwned(ctx.tenant, await ctx.db.get(args.jobId));
    if (job.status === "complete" || job.status === "cancelled") {
      throw new ConvexError({
        code: "JOB_CLOSED",
        message: `A ${job.status} job cannot be rescheduled.`,
      });
    }

    await patchDoc(ctx, args.jobId, {
      scheduledFor: args.scheduledFor,
      crewUserIds: args.crewUserIds ?? job.crewUserIds,
      status: job.status === "quoted" || job.status === "accepted" ? "scheduled" : job.status,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "job.schedule",
      entityTable: "jobs",
      entityId: args.jobId,
      before: { scheduledFor: job.scheduledFor ?? null },
      after: { scheduledFor: args.scheduledFor },
    });

    return { jobId: args.jobId, scheduledFor: args.scheduledFor };
  },
});

export const addMaterials = tenantMutation("staff")({
  args: {
    jobId: v.id("jobs"),
    materials: v.array(
      v.object({
        name: v.string(),
        quantity: v.number(),
        unitCostCents: v.number(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ jobId: Id<"jobs">; materialsCostCents: number }> => {
    const job = assertOwned(ctx.tenant, await ctx.db.get(args.jobId));
    if (job.status === "cancelled") {
      throw new ConvexError({
        code: "JOB_CLOSED",
        message: "A cancelled job does not take materials.",
      });
    }

    const added = args.materials.map((m) => {
      const name = m.name.trim();
      if (!name) {
        throw new ConvexError({ code: "INVALID", message: "A material needs a name." });
      }
      assertCents(m.unitCostCents, "unitCostCents");
      if (m.unitCostCents < 0) {
        throw new ConvexError({
          code: "BAD_MONEY",
          message: "A material cost cannot be negative.",
        });
      }
      return { name, quantity: m.quantity, unitCostCents: m.unitCostCents };
    });

    const materials = [...job.materials, ...added];
    // Throws on a mixed-currency array, so a job cannot quietly total parts
    // bought in two currencies.
    const materialsCostCents = materialsCost(materials, job.currency);

    await patchDoc(ctx, args.jobId, { materials });
    await auditWrite(ctx, ctx.tenant, {
      action: "job.addMaterials",
      entityTable: "jobs",
      entityId: args.jobId,
      after: { added: added.length, materialsCostCents },
    });

    return { jobId: args.jobId, materialsCostCents };
  },
});
