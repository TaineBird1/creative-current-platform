import { toStorageKey, toE164 } from "./lib/phone";
import { v, ConvexError } from "convex/values";
import { byName } from "./lib/ordering";
import type { Id } from "./_generated/dataModel";
import { tenantQuery, tenantMutation } from "./lib/functions";
import { assertOwned, auditWrite } from "./lib/tenancy";
import { resolveConsent } from "./lib/consent";

/**
 * CUSTOMERS — the tenant's end customers, and the lock-in memory.
 *
 * They never get platform accounts. A customer is a RECORD, not a user: no
 * sign-in, no password, no session. The booking flow asks for a name and a
 * phone number and nothing else, and this is where that lands.
 *
 * Phone is the identity, because it is the one thing a person gives correctly
 * over a counter and the channel the business actually reaches them on. Email
 * is optional and often absent.
 *
 * Merging leaves a TOMBSTONE rather than deleting. A deleted customer takes
 * their bookings, quotes and spec notes with them — the notes are the whole
 * reason a client stays, and "we lost your history" is the one mistake a
 * service business cannot explain away.
 */

export type CustomerRow = {
  _id: Id<"customers">;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  tags: string[];
  visitCount: number;
  noShowCount: number;
  lastVisitAt: number | null;
  dueForServiceAt: number | null;
  lifetimeValueCents: number;
  currency: "ZAR" | "USD" | "EUR" | "GBP" | "NAD" | "BWP";
  /** Set when this record has been merged away. Reads should follow it. */
  mergedIntoId: Id<"customers"> | null;
  isDemo: boolean;
};

/**
 * Digits only, so "082 555 1234", "0825551234" and "+27 82 555 1234" are one
 * customer rather than three. Without this the duplicate-merge tooling exists
 * to clean up a mess the write path created.
 */
/**
 * Phone storage goes through lib/phone.ts, which is the ONE place that
 * decides what a phone number is here.
 *
 * This used to be a third normaliser, producing "0833176385" where the
 * importer produced "+27833176385" and the suppression matcher produced
 * "833176385". Three canonical forms for the key that decides who may be
 * called — they agreed only because every comparison re-normalised both
 * sides, so the divergence was latent, and a guard test found it rather than
 * a person.
 */
export const normalisePhone = toStorageKey;


function toRow(doc: {
  _id: Id<"customers">;
  name: string;
  phone: string;
  email?: string;
  notes?: string;
  tags: string[];
  visitCount: number;
  noShowCount: number;
  lastVisitAt?: number;
  dueForServiceAt?: number;
  lifetimeValueCents: number;
  currency: CustomerRow["currency"];
  mergedIntoId?: Id<"customers">;
  isDemo: boolean;
}): CustomerRow {
  return {
    _id: doc._id,
    name: doc.name,
    phone: doc.phone,
    email: doc.email ?? null,
    notes: doc.notes ?? null,
    tags: doc.tags,
    visitCount: doc.visitCount,
    noShowCount: doc.noShowCount,
    lastVisitAt: doc.lastVisitAt ?? null,
    dueForServiceAt: doc.dueForServiceAt ?? null,
    lifetimeValueCents: doc.lifetimeValueCents,
    currency: doc.currency,
    mergedIntoId: doc.mergedIntoId ?? null,
    isDemo: doc.isDemo,
  };
}

export const list = tenantQuery("staff")({
  args: { includeMerged: v.optional(v.boolean()) },
  handler: async (ctx, { includeMerged }): Promise<CustomerRow[]> => {
    const rows = await ctx.db
      .query("customers")
      .withIndex("by_client_phone", (q) => q.eq("clientId", ctx.tenant.clientId))
      .collect();

    return rows
      .filter((doc) => includeMerged || !doc.mergedIntoId)
      .sort(byName((row) => row.name))
      .map(toRow);
  },
});

/**
 * Find or create by phone. This is what the booking and quote flows call, so
 * a returning customer keeps their history instead of acquiring a second
 * record every time they book.
 */
export const upsertByPhone = tenantMutation("staff")({
  args: {
    name: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    customerId: Id<"customers">;
    created: boolean;
    /**
     * False when the number cannot be normalised to E.164 — which means every
     * message to this customer will be suppressed, because a number we cannot
     * canonicalise is one we cannot check against the do-not-call list.
     *
     * Returned rather than left to be discovered in the outbox three days
     * later: the person typing it is the only one who can still ask for a
     * different number, and they can only do that if they are told now.
     */
    reachable: boolean;
  }> => {
    const name = args.name.trim();
    const phone = normalisePhone(args.phone);
    /*
     * Whether we will ever be able to MESSAGE this person. A number that does
     * not reach E.164 cannot be checked against the do-not-call list, so
     * dispatch suppresses everything to it — see lib/phone.ts. The booking is
     * still accepted; the caller is told so it can be said at the time rather
     * than found in an outbox days later.
     */
    const reachable = toE164(args.phone).ok;
    if (!name) {
      throw new ConvexError({ code: "INVALID", message: "A customer needs a name." });
    }
    if (phone.length < 9) {
      throw new ConvexError({
        code: "INVALID_PHONE",
        message: "That does not look like a phone number.",
      });
    }

    const client = await ctx.db.get(ctx.tenant.clientId);
    if (!client) throw new ConvexError({ code: "NOT_FOUND", message: "No such client." });

    const existing = await ctx.db
      .query("customers")
      .withIndex("by_client_phone", (q) =>
        q.eq("clientId", ctx.tenant.clientId).eq("phone", phone),
      )
      .first();

    if (existing) {
      /*
       * Follow the tombstone. Booking a merged-away record would resurrect a
       * duplicate the owner already resolved.
       */
      const target = existing.mergedIntoId
        ? assertOwned(ctx.tenant, await ctx.db.get(existing.mergedIntoId))
        : existing;

      /*
       * Notes are NEVER overwritten from a booking form. They are the spec
       * memory the business is paid for — "gate code, dog in the yard, prefers
       * the early slot" — and a customer retyping their name should not be
       * able to erase them.
       */
      const patch: Record<string, unknown> = {};
      if (target.name !== name) patch.name = name;
      if (args.email && !target.email) patch.email = args.email.trim();
      if (Object.keys(patch).length > 0) await ctx.db.patch(target._id, patch);

      return { customerId: target._id, created: false, reachable };
    }

    const customerId = await ctx.db.insert("customers", {
      clientId: ctx.tenant.clientId,
      name,
      phone,
      email: args.email?.trim() || undefined,
      addresses: [],
      notes: args.notes?.trim() || undefined,
      tags: [],
      noShowCount: 0,
      lifetimeValueCents: 0,
      currency: client.currency,
      visitCount: 0,
      isDemo: client.isDemo,
      isSeed: client.isSeed,
    });

    await auditWrite(ctx, ctx.tenant, {
      action: "customer.create",
      entityTable: "customers",
      entityId: customerId,
      after: { name, phone },
    });

    return { customerId, created: true, reachable };
  },
});

/** The spec memory. Owner-tier: notes about a person are not staff gossip. */
export const setNotes = tenantMutation("manager")({
  args: { customerId: v.id("customers"), notes: v.string() },
  handler: async (ctx, { customerId, notes }): Promise<{ customerId: Id<"customers"> }> => {
    const customer = assertOwned(ctx.tenant, await ctx.db.get(customerId));
    await ctx.db.patch(customerId, { notes: notes.trim() || undefined });

    await auditWrite(ctx, ctx.tenant, {
      action: "customer.setNotes",
      entityTable: "customers",
      entityId: customerId,
      before: { hadNotes: Boolean(customer.notes) },
      after: { hadNotes: Boolean(notes.trim()) },
    });

    return { customerId };
  },
});

/**
 * Merge duplicates. The loser keeps existing and points at the winner, so
 * every booking, quote and message already pointing at it still resolves.
 */
export const merge = tenantMutation("manager")({
  args: { keepId: v.id("customers"), mergeId: v.id("customers") },
  handler: async (ctx, { keepId, mergeId }): Promise<{ keepId: Id<"customers"> }> => {
    if (keepId === mergeId) {
      throw new ConvexError({ code: "INVALID", message: "Those are the same customer." });
    }
    const keep = assertOwned(ctx.tenant, await ctx.db.get(keepId));
    const loser = assertOwned(ctx.tenant, await ctx.db.get(mergeId));

    if (keep.mergedIntoId) {
      throw new ConvexError({
        code: "ALREADY_MERGED",
        message: "The record you are merging into has itself been merged away.",
      });
    }
    if (loser.mergedIntoId) {
      throw new ConvexError({ code: "ALREADY_MERGED", message: "That record is already merged." });
    }

    /*
     * Counters add; the notes are concatenated rather than picked between,
     * because choosing silently discards half of what the business knows
     * about the person.
     */
    const notes = [keep.notes, loser.notes].filter(Boolean).join("\n\n");

    await ctx.db.patch(keepId, {
      visitCount: keep.visitCount + loser.visitCount,
      noShowCount: keep.noShowCount + loser.noShowCount,
      lifetimeValueCents: keep.lifetimeValueCents + loser.lifetimeValueCents,
      lastVisitAt: Math.max(keep.lastVisitAt ?? 0, loser.lastVisitAt ?? 0) || undefined,
      notes: notes || undefined,
      email: keep.email ?? loser.email,
      tags: [...new Set([...keep.tags, ...loser.tags])],
    });

    await ctx.db.patch(mergeId, { mergedIntoId: keepId });

    await auditWrite(ctx, ctx.tenant, {
      action: "customer.merge",
      entityTable: "customers",
      entityId: mergeId,
      before: { name: loser.name, phone: loser.phone },
      after: { mergedInto: keepId },
    });

    return { keepId };
  },
});

/**
 * CONSENT (Part 6). Append-only, enforced by guards.test.ts.
 *
 * A withdrawal is a new row, not an edit, because "did they consent on the
 * day we sent that" has to remain answerable months later. Overwriting the
 * state destroys the only evidence that the send was lawful at the time.
 */
export const recordConsent = tenantMutation("staff")({
  args: {
    customerId: v.id("customers"),
    channel: v.union(v.literal("whatsapp"), v.literal("email"), v.literal("sms")),
    state: v.union(v.literal("granted"), v.literal("withdrawn")),
    lawfulBasis: v.union(
      v.literal("consent"),
      v.literal("contract"),
      v.literal("legitimate_interest"),
    ),
    source: v.string(),
  },
  handler: async (ctx, args): Promise<{ consentId: Id<"consents"> }> => {
    const customer = assertOwned(ctx.tenant, await ctx.db.get(args.customerId));
    const source = args.source.trim();
    if (!source) {
      throw new ConvexError({
        code: "INVALID",
        message: "Consent needs a source — where it was given is the evidence.",
      });
    }

    const consentId = await ctx.db.insert("consents", {
      clientId: ctx.tenant.clientId,
      customerId: customer._id,
      channel: args.channel,
      state: args.state,
      lawfulBasis: args.lawfulBasis,
      source,
      at: Date.now(),
    });

    return { consentId };
  },
});

/**
 * The CURRENT state per channel, derived from the newest row.
 *
 * Absent is not "granted". A channel with no row has never been consented to,
 * and the messaging pipeline must treat that as a refusal rather than a
 * default — which is why this returns `null` for unknown rather than a
 * boolean that would collapse the two.
 */
export const consentState = tenantQuery("staff")({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx,
    { customerId },
  ): Promise<{
    whatsapp: "granted" | "withdrawn" | null;
    email: "granted" | "withdrawn" | null;
    sms: "granted" | "withdrawn" | null;
  }> => {
    assertOwned(ctx.tenant, await ctx.db.get(customerId));

    const rows = await ctx.db
      .query("consents")
      .withIndex("by_customer_channel", (q) => q.eq("customerId", customerId))
      .collect();

    /*
     * resolveConsent, not a sort. Two rows recorded in the same millisecond
     * sort equally, and the scan order that breaks the tie is not guaranteed
     * — CI caught exactly that as a test that passed locally and failed on
     * the runner. On an exact tie, withdrawn wins.
     */
    const latest = (channel: "whatsapp" | "email" | "sms") =>
      resolveConsent(rows.filter((row) => row.channel === channel))?.state ?? null;

    return { whatsapp: latest("whatsapp"), email: latest("email"), sms: latest("sms") };
  },
});
