import { v, ConvexError } from "convex/values";
import { byOrderThenName } from "./lib/ordering";
import { ownerMutation, platformQuery } from "./lib/functions";
import { currency, ventureType } from "./tables/tenants";

/**
 * VENTURES — the portfolio dimension (Part 5.1).
 *
 * The platform business is one venture among several. Consulting clients, the
 * property work and anything else the owner runs live beside it in the same
 * console, the same database and the same ledgers, distinguished by
 * `ventureId` rather than by living in a separate app.
 *
 * The point is a question the owner cannot currently answer: what is each
 * thing actually making me? That requires every client, invoice, expense and
 * ledger entry to carry a venture, which is why this is a first-class table
 * and not a tag.
 *
 * Reading is platform-tier — an operator needs the switcher to make any list
 * meaningful. Writing is OWNER-tier: a venture is a reporting boundary, and
 * an operator who can mint one can quietly move money out of a P&L.
 */

export const list = platformQuery({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived }) => {
    const ventures = await ctx.db.query("ventures").collect();
    const rows = [];

    for (const venture of ventures) {
      if (!venture.active && !includeArchived) continue;

      /*
       * Counted per venture rather than joined in the client list, because
       * the switcher has to show "empty" honestly. A venture with no clients
       * is a real state — a property venture exists before its first unit —
       * and hiding it would make the switcher lie about what exists.
       */
      const clients = await ctx.db
        .query("clients")
        .withIndex("by_venture", (q) => q.eq("ventureId", venture._id))
        .collect();

      rows.push({
        _id: venture._id,
        name: venture.name,
        type: venture.type,
        currency: venture.currency,
        active: venture.active,
        sortOrder: venture.sortOrder,
        clientCount: clients.length,
        liveClientCount: clients.filter((c) => c.status === "live").length,
      });
    }

    return rows.sort(byOrderThenName);
  },
});

export const create = ownerMutation({
  args: {
    name: v.string(),
    type: ventureType,
    currency,
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) {
      throw new ConvexError({ code: "INVALID", message: "A venture needs a name." });
    }

    const existing = await ctx.db.query("ventures").collect();

    /*
     * Case-insensitive, because "Sites" and "sites" in a venture switcher is
     * a reporting bug wearing a typo's clothes: entries split across two
     * ventures that a human reads as one, and a P&L that silently omits half.
     */
    if (existing.some((venture) => venture.name.trim().toLowerCase() === name.toLowerCase())) {
      throw new ConvexError({
        code: "DUPLICATE_VENTURE",
        message: `A venture named "${name}" already exists.`,
      });
    }

    /*
     * Exactly one platform venture. It is the agency itself, every platform
     * client hangs off it, and a second one would make "what is the platform
     * making me" unanswerable without anyone noticing it had become so.
     */
    if (args.type === "platform" && existing.some((venture) => venture.type === "platform")) {
      throw new ConvexError({
        code: "PLATFORM_VENTURE_EXISTS",
        message: "The platform venture already exists. There can only be one.",
      });
    }

    const ventureId = await ctx.db.insert("ventures", {
      name,
      type: args.type,
      currency: args.currency,
      active: true,
      sortOrder: existing.length + 1,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      action: "venture.create",
      entityTable: "ventures",
      entityId: ventureId,
      ventureId,
      after: { name, type: args.type, currency: args.currency },
      at: Date.now(),
    });

    return { ventureId, name };
  },
});

/**
 * Archive rather than delete. Ledger entries, invoices and expenses point at
 * a venture forever; removing the row would orphan history and break every
 * past statement. Archiving hides it from the switcher and nothing else.
 */
export const setActive = ownerMutation({
  args: { ventureId: v.id("ventures"), active: v.boolean() },
  handler: async (ctx, { ventureId, active }) => {
    const venture = await ctx.db.get(ventureId);
    if (!venture) {
      throw new ConvexError({ code: "NOT_FOUND", message: "No such venture." });
    }

    if (!active) {
      const clients = await ctx.db
        .query("clients")
        .withIndex("by_venture", (q) => q.eq("ventureId", ventureId))
        .collect();
      const live = clients.filter((c) => c.status === "live");
      if (live.length > 0) {
        throw new ConvexError({
          code: "VENTURE_HAS_LIVE_CLIENTS",
          message: `${live.length} live client(s) still belong to this venture.`,
        });
      }
    }

    await ctx.db.patch(ventureId, { active });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      action: active ? "venture.restore" : "venture.archive",
      entityTable: "ventures",
      entityId: ventureId,
      ventureId,
      before: { active: venture.active },
      after: { active },
      at: Date.now(),
    });

    return { ventureId, active };
  },
});
