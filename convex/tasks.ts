import { v, ConvexError } from "convex/values";
import { platformMutation, platformQuery } from "./lib/functions";
import type { Doc } from "./_generated/dataModel";
import { patchDoc } from "./lib/db";

/**
 * ONE INBOX.
 *
 * The thing that is currently a note beside the phone: "send them the quote
 * Thursday", "chase INV-0003", "call the accountant back". Not a project
 * manager — a list of things that will otherwise be forgotten, sorted by how
 * late they are.
 *
 * WHAT IS DERIVED AND WHAT IS STORED, since this codebase has been strict
 * about the difference and gets a different answer here.
 *
 *   OVERDUE is derived. It is a fact about today, and a stored "overdue"
 *   flag is stale the moment midnight passes — the same reasoning that keeps
 *   it off invoices.
 *
 *   DONE is stored, and it has to be. An invoice is paid because money
 *   arrived and the ledger can be counted; a task is done because a PERSON
 *   judged it done, and there is nothing else to compute that from. Storing
 *   invoice settlement was a bug because a truer source existed. Here there
 *   is none, so this is not the same mistake wearing a different hat.
 *
 * `status` and `completedAt` are written together, by these mutations only,
 * because two fields that must agree are two fields that will eventually
 * disagree.
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

export type TaskRow = {
  taskId: string;
  title: string;
  body: string | null;
  ventureId: string;
  clientId: string | null;
  leadId: string | null;
  dueAt: number | null;
  status: Doc<"tasks">["status"];
  completedAt: number | null;
  /** Derived from today. Never written down. */
  overdue: boolean;
  /** Negative once late. Not clamped — "4 days late" is not "due today". */
  dueInDays: number | null;
  /** Set when automation made it, so a task nobody remembers writing is explicable. */
  triggerKey: string | null;
};

function toRow(task: Doc<"tasks">, now: number): TaskRow {
  const dueAt = task.dueAt ?? null;
  const open = task.status === "open" || task.status === "doing";
  return {
    taskId: task._id,
    title: task.title,
    body: task.body ?? null,
    ventureId: task.ventureId,
    clientId: task.clientId ?? null,
    leadId: task.leadId ?? null,
    dueAt,
    status: task.status,
    completedAt: task.completedAt ?? null,
    overdue: open && dueAt !== null && dueAt < now,
    dueInDays: dueAt === null ? null : Math.floor((dueAt - now) / (24 * 60 * 60 * 1000)),
    triggerKey: task.triggerKey ?? null,
  };
}

export const create = platformMutation({
  args: {
    ventureId: v.id("ventures"),
    title: v.string(),
    body: v.optional(v.string()),
    clientId: v.optional(v.id("clients")),
    leadId: v.optional(v.id("leads")),
    /**
     * Optional on purpose. "Someday" is a real category, and forcing a date
     * makes people type a fake one — which is worse than no date, because a
     * fake date sorts into the list and pushes real work down.
     */
    dueAt: v.optional(v.number()),
    triggerKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    if (title.length < 2) {
      throw bad("INVALID", "A task needs a title you will recognise in a week.");
    }

    const venture = await ctx.db.get(args.ventureId);
    if (!venture) throw bad("NO_SUCH_VENTURE", "No such venture.");

    /*
     * The client must belong to the venture, same invariant as money. A task
     * filed under the wrong venture is invisible to the person filtering by
     * the right one, which is the same as not existing.
     */
    if (args.clientId) {
      const client = await ctx.db.get(args.clientId);
      if (!client) throw bad("NO_SUCH_CLIENT", "No such client.");
      if (client.ventureId !== args.ventureId) {
        throw bad(
          "CLIENT_VENTURE_MISMATCH",
          `${client.name} does not belong to ${venture.name}. A task filed under the wrong venture is a task nobody finds.`,
        );
      }
    }

    const taskId = await ctx.db.insert("tasks", {
      ventureId: args.ventureId,
      clientId: args.clientId,
      leadId: args.leadId,
      title,
      body: args.body?.trim() || undefined,
      assigneeUserId: ctx.platform.userId,
      dueAt: args.dueAt,
      status: "open",
      triggerKey: args.triggerKey,
    });

    return { taskId };
  },
});

/**
 * Done, and when.
 *
 * The status and the timestamp are set in one write. Setting them separately
 * would allow a task marked done with no completion time, which reads as
 * finished and cannot answer "when did that happen" — the only question
 * anybody asks a fortnight later.
 */
export const complete = platformMutation({
  args: { taskId: v.id("tasks"), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw bad("NOT_FOUND", "No such task.");
    if (task.status === "done") return { alreadyDone: true as const };

    const now = args.now ?? Date.now();
    await patchDoc(ctx, args.taskId, { status: "done", completedAt: now });
    return { alreadyDone: false as const, completedAt: now };
  },
});

/**
 * Reopen. Clears the completion time with the status, in one write.
 *
 * A reopened task that kept its old `completedAt` would claim to have been
 * finished at a moment it demonstrably was not.
 */
export const reopen = platformMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw bad("NOT_FOUND", "No such task.");
    await patchDoc(ctx, taskId, { status: "open", completedAt: undefined });
    return { ok: true as const };
  },
});

/**
 * Cancel. Distinct from done, and the distinction is the point.
 *
 * "I did it" and "it stopped being worth doing" are different answers to the
 * same question, and collapsing them into one makes a completed-work list
 * that flatters whoever is reading it.
 */
export const cancel = platformMutation({
  args: { taskId: v.id("tasks"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw bad("NOT_FOUND", "No such task.");
    const reason = args.reason?.trim();
    await patchDoc(ctx, args.taskId, {
      status: "cancelled",
      completedAt: undefined,
      body: reason ? [task.body, `Cancelled: ${reason}`].filter(Boolean).join("\n") : task.body,
    });
    return { ok: true as const };
  },
});

/**
 * The inbox, grouped by how late it is.
 *
 * Grouped rather than one flat list sorted by date, because those are
 * different questions. A flat list answers "what is next"; the groups answer
 * "am I behind", which is the one that changes what you do this morning.
 *
 * UNDATED TASKS ARE THEIR OWN GROUP rather than sorted to the end or hidden.
 * "Someday" is a real category and the reason people write fake due dates is
 * that a system offers them nowhere else to put it.
 */
export const inbox = platformQuery({
  args: {
    ventureId: v.optional(v.id("ventures")),
    /** Finished work, for the fortnightly look back. Off by default. */
    includeDone: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const all = await ctx.db.query("tasks").collect();

    const mine = all
      .filter((task) => (args.ventureId ? task.ventureId === args.ventureId : true))
      .filter((task) => (args.includeDone ? true : task.status === "open" || task.status === "doing"))
      .map((task) => toRow(task, now));

    /*
     * Sorted by due date, with UNDATED LAST and a stable tie-break on the id.
     * Two tasks due the same morning must not swap places between refreshes —
     * the same rule as every other list here.
     */
    const byDue = (a: TaskRow, b: TaskRow) =>
      (a.dueAt ?? Number.POSITIVE_INFINITY) - (b.dueAt ?? Number.POSITIVE_INFINITY) ||
      (a.taskId < b.taskId ? -1 : 1);

    const open = mine.filter((task) => task.status === "open" || task.status === "doing");
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    return {
      overdue: open.filter((task) => task.overdue).sort(byDue),
      today: open
        .filter((task) => !task.overdue && task.dueAt !== null && task.dueAt <= endOfToday.getTime())
        .sort(byDue),
      upcoming: open
        .filter((task) => !task.overdue && task.dueAt !== null && task.dueAt > endOfToday.getTime())
        .sort(byDue),
      undated: open.filter((task) => task.dueAt === null).sort(byDue),
      done: args.includeDone
        ? mine
            .filter((task) => task.status === "done")
            .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || (a.taskId < b.taskId ? -1 : 1))
        : [],
      /*
       * The one number worth seeing before the list. If it is not zero the
       * morning starts there, and if it is, the list can wait.
       */
      overdueCount: open.filter((task) => task.overdue).length,
    };
  },
});
