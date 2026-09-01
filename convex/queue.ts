import { v, ConvexError } from "convex/values";
import { platformQuery, platformMutation } from "./lib/functions";
import { listContactable, getWithVerdict } from "./lib/leadAccess";
import { byAsc } from "./lib/ordering";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * TODAY'S QUEUE — the list you work down with a phone in your hand.
 *
 * Every lead here has already passed the suppression filter inside
 * `listContactable`, which is the point: a suppressed business is never drawn,
 * so there is no name on the screen to phone from your own handset. See
 * lib/leadAccess.ts for why filtering at the dial is a step too late.
 *
 * ORDER IS THE PRODUCT. A queue you have to think about is a queue you stop
 * working, so this returns leads in the order to call them and nothing else
 * needs deciding at 09:00.
 */

/** A callback the prospect asked for outranks everything. They are expecting it. */
const RANK = { callback: 0, due: 1, fresh: 2 } as const;
type Rank = keyof typeof RANK;

export type QueueRow = {
  leadId: Id<"leads">;
  businessName: string;
  phone: string | null;
  suburb: string | null;
  niche: string;
  rank: Rank;
  /** When this became callable. Callbacks carry the time the prospect chose. */
  dueAt: number;
  auditFaults: string[];
  callNote: string | null;
  ownerName: string | null;
  ownerNameConfidence: string | null;
  attempts: number;
  lastOutcome: string | null;
  /** Answers "where did you get my number" without a second query. */
  source: string;
  capturedAt: number;
};

export const today = platformQuery({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    rows: QueueRow[];
    /** Shown to the caller so an empty queue is never a mystery. */
    suppressedCount: number;
    /**
     * True when the suppression list could not be read. The queue is EMPTY in
     * that case rather than unfiltered — see filterContactable — and the UI
     * has to say so, because an empty queue and a broken one look identical
     * and only one of them means "you are done for the day".
     */
    listUnavailable: boolean;
  }> => {
    const now = args.now ?? Date.now();

    /*
     * Candidates first, filter second. The filter is applied to whatever set
     * is assembled here, so a future addition to this query cannot route
     * around it by accident — it can only add to what gets filtered.
     */
    const enrolments = await ctx.db
      .query("sequenceEnrolments")
      .withIndex("by_status_dueAt", (q) => q.eq("status", "active").lte("dueAt", now))
      .collect();

    const byLead = new Map<Id<"leads">, { dueAt: number; rank: Rank }>();
    for (const enrolment of enrolments) {
      byLead.set(enrolment.leadId, { dueAt: enrolment.dueAt, rank: "due" });
    }

    // A prospect who asked to be called back at 14:00 is expecting the phone
    // to ring. That outranks anything a cadence scheduled.
    const dispositions = await ctx.db.query("dispositions").collect();
    for (const disposition of dispositions) {
      if (disposition.outcome !== "callback" || !disposition.callbackAt) continue;
      if (disposition.callbackAt > now) continue;
      byLead.set(disposition.leadId, { dueAt: disposition.callbackAt, rank: "callback" });
    }

    // Never-worked leads, so a queue is never empty while there is work.
    const fresh = await ctx.db
      .query("leads")
      .withIndex("by_status", (q) => q.eq("status", "new"))
      .take(200);
    for (const lead of fresh) {
      if (!byLead.has(lead._id)) {
        byLead.set(lead._id, { dueAt: lead.provenance.capturedAt, rank: "fresh" });
      }
    }

    const candidates: Doc<"leads">[] = [];
    for (const leadId of byLead.keys()) {
      const lead = await ctx.db.get(leadId);
      if (!lead) continue;
      if (lead.status === "discarded" || lead.status === "converted") continue;
      candidates.push(lead);
    }

    /*
     * THE FILTER. Not optional, not a parameter, not something this query
     * decides — the only route to a list of leads applies it.
     */
    const { leads, suppressedCount, listUnavailable } = await listContactable(ctx, candidates);

    const attemptsByLead = new Map<string, Doc<"dispositions">[]>();
    for (const disposition of dispositions) {
      const key = disposition.leadId as string;
      attemptsByLead.set(key, [...(attemptsByLead.get(key) ?? []), disposition]);
    }

    const rows: QueueRow[] = leads.map((lead) => {
      const meta = byLead.get(lead._id)!;
      const attempts = (attemptsByLead.get(lead._id as string) ?? []).sort(
        byAsc((row) => row.calledAt),
      );
      const last = attempts[attempts.length - 1];
      return {
        leadId: lead._id,
        businessName: lead.businessName,
        phone: lead.phone ?? null,
        suburb: null,
        niche: lead.niche,
        rank: meta.rank,
        dueAt: meta.dueAt,
        auditFaults: lead.auditFaults,
        callNote: lead.callNote ?? null,
        ownerName: lead.ownerName ?? null,
        ownerNameConfidence: lead.ownerNameConfidence ?? null,
        attempts: attempts.length,
        lastOutcome: last?.outcome ?? null,
        source: lead.provenance.source,
        capturedAt: lead.provenance.capturedAt,
      };
    });

    rows.sort(
      (a, b) => RANK[a.rank] - RANK[b.rank] || a.dueAt - b.dueAt || (a.leadId < b.leadId ? -1 : 1),
    );

    return { rows: rows.slice(0, args.limit ?? 50), suppressedCount, listUnavailable };
  },
});

/**
 * One lead, for the call itself. Carries the verdict, so a screen showing a
 * suppressed business shows WHY rather than pretending it does not exist.
 */
export const lead = platformQuery({
  args: { leadId: v.id("leads") },
  handler: async (ctx, { leadId }) => {
    const found = await getWithVerdict(ctx, leadId);
    if (!found) throw new ConvexError({ code: "NOT_FOUND", message: "No such lead." });

    return {
      leadId: found.lead._id,
      businessName: found.lead.businessName,
      // The number is returned even when blocked, because this screen exists
      // to answer "what happened with them" — but never without the verdict.
      phone: found.lead.phone ?? null,
      website: found.lead.website ?? null,
      niche: found.lead.niche,
      auditScore: found.lead.auditScore ?? null,
      auditFaults: found.lead.auditFaults,
      callNote: found.lead.callNote ?? null,
      ownerName: found.lead.ownerName ?? null,
      ownerNameConfidence: found.lead.ownerNameConfidence ?? null,
      status: found.lead.status,
      /** "Where did you get my number", answered from the row. */
      provenance: found.lead.provenance,
      blocked: found.verdict.blocked,
      blockedReason: found.verdict.blocked ? found.verdict.reason : null,
    };
  },
});

/**
 * Record what happened on a call.
 *
 * `not_interested` and `wrong_number` write a SUPPRESSION as well as a
 * disposition, so the refusal takes effect on the next queue rather than
 * being a note somebody has to remember to act on. That is the whole reason
 * the filter is at the query: this write is what makes them disappear.
 */
export const disposition = platformMutation({
  args: {
    leadId: v.id("leads"),
    outcome: v.union(
      v.literal("no_answer"),
      v.literal("voicemail"),
      v.literal("callback"),
      v.literal("meeting_set"),
      v.literal("not_interested"),
      v.literal("wrong_number"),
    ),
    note: v.optional(v.string()),
    callbackAt: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new ConvexError({ code: "NOT_FOUND", message: "No such lead." });

    const now = args.now ?? Date.now();

    if (args.outcome === "callback" && !args.callbackAt) {
      throw new ConvexError({
        code: "CALLBACK_NEEDS_A_TIME",
        message: "A callback without a time is a promise nobody can keep. When did they say?",
      });
    }

    await ctx.db.insert("dispositions", {
      leadId: args.leadId,
      userId: ctx.platform.userId,
      outcome: args.outcome,
      note: args.note?.trim() || undefined,
      calledAt: now,
      callbackAt: args.callbackAt,
    });

    /*
     * A refusal becomes a suppression IMMEDIATELY, not a task for later. The
     * gap between "they said no" and "they stop appearing" is the window in
     * which somebody phones them again, and the person on the other end has
     * no way of knowing it was an administrative delay rather than contempt.
     */
    if (args.outcome === "not_interested" || args.outcome === "wrong_number") {
      const reason =
        args.outcome === "wrong_number"
          ? `wrong number — recorded on a call ${new Date(now).toISOString().slice(0, 10)}`
          : `asked not to be contacted — recorded on a call ${new Date(now).toISOString().slice(0, 10)}`;

      /*
       * Suppress on EVERY identifier the lead has. The placeId stops this
       * business reappearing from a future Places pull under a slightly
       * different name; the phone stops the same number reaching us through
       * another source entirely. Either one alone leaves a way back on.
       *
       * Not every lead has a placeId — a directory-sourced one has none — so
       * this writes what exists rather than assuming Google was involved.
       */
      let wrote = 0;
      if (lead.placeId) {
        await ctx.db.insert("suppressions", {
          kind: "placeId", value: lead.placeId, reason, createdAt: now,
        });
        wrote++;
      }
      if (lead.phone) {
        await ctx.db.insert("suppressions", {
          kind: "phone", value: lead.phone, reason, createdAt: now,
        });
        wrote++;
      }

      /*
       * A refusal we cannot record against anything is not a refusal. The
       * lead is still discarded below, but a name fragment is written so the
       * business cannot walk back in from another source under the same name
       * — which is the whole failure this branch exists to prevent.
       */
      if (wrote === 0) {
        await ctx.db.insert("suppressions", {
          kind: "nameFragment", value: lead.businessName, reason, createdAt: now,
        });
      }
      await ctx.db.patch(args.leadId, { status: "discarded" });
    } else if (lead.status === "new") {
      await ctx.db.patch(args.leadId, { status: "working" });
    }

    return { ok: true as const };
  },
});
