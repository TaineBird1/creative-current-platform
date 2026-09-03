import { v, ConvexError } from "convex/values";
import { byOrderThenName } from "./lib/ordering";
import type { Id } from "./_generated/dataModel";
import { tenantQuery, tenantMutation } from "./lib/functions";
import { assertOwned, auditWrite } from "./lib/tenancy";
import { assertCents } from "./lib/money";
import { patchDoc } from "./lib/db";

/**
 * SERVICES — what a tenant sells, and the thing a booking books.
 *
 * Duration and buffers live here rather than on the booking, because they are
 * a property of the work, not of the appointment. A cut is 45 minutes
 * everywhere it appears; changing that must not require rewriting history.
 *
 * `quoteRequired` is what routes a visitor to the quote flow instead of the
 * calendar. A service with no price and no quote flag is a dead end on the
 * public site — someone can select it and then be shown neither a price nor a
 * way to ask for one — so that combination is refused at the write.
 *
 * Structure is owner-tier. A manager runs a branch; letting them retitle or
 * reprice the catalogue makes the same service mean different things in two
 * places, which breaks reporting quietly rather than loudly.
 */

export type ServiceRow = {
  _id: Id<"services">;
  key: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** The slot a booking actually consumes: buffers are not free time. */
  totalMinutes: number;
  priceCents: number | null;
  currency: "ZAR" | "USD" | "EUR" | "GBP" | "NAD" | "BWP";
  quoteRequired: boolean;
  active: boolean;
  sortOrder: number;
  locationIds: Id<"locations">[] | null;
};

function toRow(doc: {
  _id: Id<"services">;
  key: string;
  name: string;
  description?: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceCents?: number;
  currency: ServiceRow["currency"];
  quoteRequired: boolean;
  active: boolean;
  sortOrder: number;
  locationIds?: Id<"locations">[];
}): ServiceRow {
  return {
    _id: doc._id,
    key: doc.key,
    name: doc.name,
    description: doc.description ?? null,
    durationMinutes: doc.durationMinutes,
    bufferBeforeMinutes: doc.bufferBeforeMinutes,
    bufferAfterMinutes: doc.bufferAfterMinutes,
    totalMinutes: doc.bufferBeforeMinutes + doc.durationMinutes + doc.bufferAfterMinutes,
    priceCents: doc.priceCents ?? null,
    currency: doc.currency,
    quoteRequired: doc.quoteRequired,
    active: doc.active,
    sortOrder: doc.sortOrder,
    locationIds: doc.locationIds ?? null,
  };
}

export const list = tenantQuery("staff")({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { includeInactive }): Promise<ServiceRow[]> => {
    const rows = await ctx.db
      .query("services")
      .withIndex("by_client", (q) => q.eq("clientId", ctx.tenant.clientId))
      .collect();

    return rows
      .filter((doc) => includeInactive || doc.active)
      .sort(byOrderThenName)
      .map(toRow);
  },
});

export const create = tenantMutation("owner")({
  args: {
    key: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    durationMinutes: v.number(),
    bufferBeforeMinutes: v.optional(v.number()),
    bufferAfterMinutes: v.optional(v.number()),
    priceCents: v.optional(v.number()),
    quoteRequired: v.optional(v.boolean()),
    locationIds: v.optional(v.array(v.id("locations"))),
  },
  handler: async (ctx, args): Promise<{ serviceId: Id<"services">; key: string }> => {
    const key = args.key.trim().toLowerCase();
    const name = args.name.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      throw new ConvexError({
        code: "INVALID_KEY",
        message: "A service key is lowercase letters, numbers and hyphens.",
      });
    }
    if (!name) {
      throw new ConvexError({ code: "INVALID", message: "A service needs a name." });
    }

    /*
     * The key is how a SiteConfig section points at a service, so a duplicate
     * would make a published site reference two different things by one name
     * and resolve to whichever came back first.
     */
    const existing = await ctx.db
      .query("services")
      .withIndex("by_client", (q) => q.eq("clientId", ctx.tenant.clientId))
      .collect();
    if (existing.some((doc) => doc.key === key)) {
      throw new ConvexError({
        code: "DUPLICATE_KEY",
        message: `A service with the key "${key}" already exists.`,
      });
    }

    const durationMinutes = args.durationMinutes;
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      throw new ConvexError({
        code: "INVALID_DURATION",
        message: "Duration is whole minutes, greater than zero.",
      });
    }
    const bufferBeforeMinutes = args.bufferBeforeMinutes ?? 0;
    const bufferAfterMinutes = args.bufferAfterMinutes ?? 0;
    for (const [field, value] of [
      ["bufferBeforeMinutes", bufferBeforeMinutes],
      ["bufferAfterMinutes", bufferAfterMinutes],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new ConvexError({
          code: "INVALID_BUFFER",
          message: `${field} is whole minutes, zero or more.`,
        });
      }
    }

    const quoteRequired = args.quoteRequired ?? false;
    if (args.priceCents !== undefined) assertCents(args.priceCents, "priceCents");
    if (args.priceCents !== undefined && args.priceCents < 0) {
      throw new ConvexError({ code: "BAD_MONEY", message: "A price cannot be negative." });
    }

    /*
     * A DEAD END, refused. No price and no quote flow means a visitor can
     * pick this service on the public site and then be shown neither a number
     * nor a way to ask for one. Nothing downstream catches it, because both
     * fields are individually valid.
     */
    if (args.priceCents === undefined && !quoteRequired) {
      throw new ConvexError({
        code: "UNPRICEABLE_SERVICE",
        message:
          `"${name}" has no price and does not require a quote. A visitor would ` +
          "see no way to find out what it costs. Set a price, or turn on quote-required.",
      });
    }

    const client = await ctx.db.get(ctx.tenant.clientId);
    if (!client) throw new ConvexError({ code: "NOT_FOUND", message: "No such client." });

    if (args.locationIds) {
      for (const locationId of args.locationIds) {
        assertOwned(ctx.tenant, await ctx.db.get(locationId));
      }
    }

    const serviceId = await ctx.db.insert("services", {
      clientId: ctx.tenant.clientId,
      locationIds: args.locationIds,
      key,
      name,
      description: args.description?.trim() || undefined,
      durationMinutes,
      bufferBeforeMinutes,
      bufferAfterMinutes,
      priceCents: args.priceCents,
      // Denormalised from the client so an amount is never readable without
      // the currency that gives it meaning.
      currency: client.currency,
      quoteRequired,
      active: true,
      sortOrder: existing.length + 1,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "service.create",
      entityTable: "services",
      entityId: serviceId,
      after: { key, name, durationMinutes, priceCents: args.priceCents ?? null, quoteRequired },
    });

    return { serviceId, key };
  },
});

export const update = tenantMutation("owner")({
  args: {
    serviceId: v.id("services"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    bufferBeforeMinutes: v.optional(v.number()),
    bufferAfterMinutes: v.optional(v.number()),
    priceCents: v.optional(v.number()),
    /*
     * Clearing needs its own signal. An absent optional arg means "leave this
     * alone", so `priceCents: undefined` cannot also mean "remove the price"
     * — without this flag a service could never move from fixed-price to
     * quote-only, which is an ordinary thing for a trades business to do.
     */
    clearPrice: v.optional(v.boolean()),
    quoteRequired: v.optional(v.boolean()),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ serviceId: Id<"services"> }> => {
    const service = assertOwned(ctx.tenant, await ctx.db.get(args.serviceId));

    if (args.clearPrice && args.priceCents !== undefined) {
      throw new ConvexError({
        code: "INVALID",
        message: "Pass a price or clear it, not both.",
      });
    }

    const next = {
      name: args.name?.trim() ?? service.name,
      description:
        args.description === undefined ? service.description : args.description.trim() || undefined,
      durationMinutes: args.durationMinutes ?? service.durationMinutes,
      bufferBeforeMinutes: args.bufferBeforeMinutes ?? service.bufferBeforeMinutes,
      bufferAfterMinutes: args.bufferAfterMinutes ?? service.bufferAfterMinutes,
      priceCents: args.clearPrice ? undefined : (args.priceCents ?? service.priceCents),
      quoteRequired: args.quoteRequired ?? service.quoteRequired,
      active: args.active ?? service.active,
    };

    if (!next.name) {
      throw new ConvexError({ code: "INVALID", message: "A service needs a name." });
    }
    if (!Number.isInteger(next.durationMinutes) || next.durationMinutes <= 0) {
      throw new ConvexError({
        code: "INVALID_DURATION",
        message: "Duration is whole minutes, greater than zero.",
      });
    }
    if (next.priceCents !== undefined) assertCents(next.priceCents, "priceCents");

    // The same dead end is refused on the way in AND on the way through.
    if (next.priceCents === undefined && !next.quoteRequired) {
      throw new ConvexError({
        code: "UNPRICEABLE_SERVICE",
        message:
          "Removing the price from a service that does not require a quote would leave " +
          "visitors with no way to find out what it costs.",
      });
    }

    await patchDoc(ctx, args.serviceId, next);

    await auditWrite(ctx, ctx.tenant, {
      action: "service.update",
      entityTable: "services",
      entityId: args.serviceId,
      before: {
        name: service.name,
        priceCents: service.priceCents ?? null,
        active: service.active,
      },
      after: { name: next.name, priceCents: next.priceCents ?? null, active: next.active },
    });

    return { serviceId: args.serviceId };
  },
});
