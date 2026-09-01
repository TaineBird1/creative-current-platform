import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * THE INBOX.
 *
 * The thing that is currently a note beside the phone. The failures worth
 * testing are the ones that make a list quietly untrustworthy: a task that
 * says it is done without saying when, a fake due date crowding out real
 * work, and a list that reorders itself between two looks.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

/** A Tuesday, mid-morning. */
const NOW = new Date(2026, 8, 1, 10, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const h = harness();
  const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
    email: "owner@thecreativecurrent.co.za",
  });
  const owner = asUser(h, userId);
  const { ventureId } = await owner.mutation(api.ventures.create, {
    name: "Sites",
    type: "platform",
    currency: "ZAR",
  });
  const { ventureId: other } = await owner.mutation(api.ventures.create, {
    name: "Consulting",
    type: "consulting",
    currency: "ZAR",
  });
  return { h, owner, ventureId, other };
}

describe("done is stored, and never without a when", () => {
  test("completing writes the status and the time together", async () => {
    /*
     * Two fields that must agree are two fields that can disagree. "Done"
     * with no completion time reads as finished and cannot answer the only
     * question anybody asks a fortnight later.
     */
    const s = await setup();
    const { taskId } = await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId,
      title: "Send Upper Highway the quote",
    });

    const result = await s.owner.mutation(api.tasks.complete, { taskId, now: NOW });
    expect(result.alreadyDone).toBe(false);

    const row = await s.h.run((ctx) => ctx.db.get(taskId));
    expect(row?.status).toBe("done");
    expect(row?.completedAt).toBe(NOW);
  });

  test("reopening clears the time with the status", async () => {
    // A reopened task keeping its old completedAt would claim to have been
    // finished at a moment it demonstrably was not.
    const s = await setup();
    const { taskId } = await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId,
      title: "Chase INV-0003",
    });
    await s.owner.mutation(api.tasks.complete, { taskId, now: NOW });
    await s.owner.mutation(api.tasks.reopen, { taskId });

    const row = await s.h.run((ctx) => ctx.db.get(taskId));
    expect(row?.status).toBe("open");
    expect(row?.completedAt).toBeUndefined();
  });

  test("completing twice is not an error and does not move the time", async () => {
    // A double tap on a phone must not rewrite when the work happened.
    const s = await setup();
    const { taskId } = await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId,
      title: "Call the accountant",
    });
    await s.owner.mutation(api.tasks.complete, { taskId, now: NOW });
    const second = await s.owner.mutation(api.tasks.complete, { taskId, now: NOW + DAY });

    expect(second.alreadyDone).toBe(true);
    expect((await s.h.run((ctx) => ctx.db.get(taskId)))?.completedAt).toBe(NOW);
  });

  test("cancelled is NOT done, and carries no completion time", async () => {
    /*
     * "I did it" and "it stopped being worth doing" are different answers.
     * Collapsing them makes a completed-work list that flatters whoever is
     * reading it — which is the person who wrote the tasks.
     */
    const s = await setup();
    const { taskId } = await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId,
      title: "Follow up with Sunworx",
    });
    await s.owner.mutation(api.tasks.cancel, { taskId, reason: "Wrong ICP, national company" });

    const row = await s.h.run((ctx) => ctx.db.get(taskId));
    expect(row?.status).toBe("cancelled");
    expect(row?.completedAt).toBeUndefined();
    expect(row?.body).toMatch(/Wrong ICP/);

    const inbox = await s.owner.query(api.tasks.inbox, { includeDone: true, now: NOW });
    expect(inbox.done).toEqual([]);
  });
});

describe("overdue is derived from today", () => {
  test("a task due yesterday is overdue; one due tomorrow is not", async () => {
    const s = await setup();
    await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId, title: "Late thing", dueAt: NOW - DAY,
    });
    await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId, title: "Future thing", dueAt: NOW + DAY,
    });

    const inbox = await s.owner.query(api.tasks.inbox, { now: NOW });
    expect(inbox.overdue.map((t) => t.title)).toEqual(["Late thing"]);
    expect(inbox.upcoming.map((t) => t.title)).toEqual(["Future thing"]);
    expect(inbox.overdueCount).toBe(1);
  });

  test("nothing is written down — the same task is not overdue at an earlier now", async () => {
    // The reason it is derived. A stored flag is stale the moment midnight
    // passes, and this is the same fact read at two times.
    const s = await setup();
    await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId, title: "Due Friday", dueAt: NOW + 3 * DAY,
    });

    expect((await s.owner.query(api.tasks.inbox, { now: NOW })).overdueCount).toBe(0);
    expect(
      (await s.owner.query(api.tasks.inbox, { now: NOW + 4 * DAY })).overdueCount,
    ).toBe(1);
  });

  test("lateness is reported in negative days, not clamped", async () => {
    // "4 days late" and "due today" need different responses.
    const s = await setup();
    await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId, title: "Very late", dueAt: NOW - 4 * DAY,
    });
    const inbox = await s.owner.query(api.tasks.inbox, { now: NOW });
    expect(inbox.overdue[0]?.dueInDays).toBe(-4);
  });

  test("a DONE task is never overdue, whatever its due date", async () => {
    const s = await setup();
    const { taskId } = await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId, title: "Done but was late", dueAt: NOW - 5 * DAY,
    });
    await s.owner.mutation(api.tasks.complete, { taskId, now: NOW });
    const inbox = await s.owner.query(api.tasks.inbox, { includeDone: true, now: NOW });
    expect(inbox.overdueCount).toBe(0);
    expect(inbox.done[0]?.overdue).toBe(false);
  });
});

describe("the inbox groups by how late it is", () => {
  test("overdue, today, upcoming and undated are separate", async () => {
    const s = await setup();
    for (const [title, dueAt] of [
      ["Yesterday", NOW - DAY],
      ["Later today", NOW + 4 * 60 * 60 * 1000],
      ["Next week", NOW + 7 * DAY],
    ] as const) {
      await s.owner.mutation(api.tasks.create, { ventureId: s.ventureId, title, dueAt });
    }
    await s.owner.mutation(api.tasks.create, { ventureId: s.ventureId, title: "Someday" });

    const inbox = await s.owner.query(api.tasks.inbox, { now: NOW });
    expect(inbox.overdue.map((t) => t.title)).toEqual(["Yesterday"]);
    expect(inbox.today.map((t) => t.title)).toEqual(["Later today"]);
    expect(inbox.upcoming.map((t) => t.title)).toEqual(["Next week"]);
    expect(inbox.undated.map((t) => t.title)).toEqual(["Someday"]);
  });

  test("an UNDATED task has its own group rather than being hidden or sorted last", async () => {
    /*
     * "Someday" is a real category. The reason people type fake due dates is
     * that a system gives them nowhere else to put it — and a fake date
     * sorts into the list and pushes real work down.
     */
    const s = await setup();
    await s.owner.mutation(api.tasks.create, { ventureId: s.ventureId, title: "Rewrite the bio" });
    const inbox = await s.owner.query(api.tasks.inbox, { now: NOW });
    expect(inbox.undated).toHaveLength(1);
    expect(inbox.overdue).toEqual([]);
    expect(inbox.upcoming).toEqual([]);
  });

  test("two tasks due the same moment do not swap places between reads", async () => {
    // Same rule as every other list here: a tie breaks on the id, so the
    // order cannot drift under someone's eyes.
    const s = await setup();
    for (const title of ["Alpha", "Bravo", "Charlie"]) {
      await s.owner.mutation(api.tasks.create, {
        ventureId: s.ventureId, title, dueAt: NOW + DAY,
      });
    }
    const first = await s.owner.query(api.tasks.inbox, { now: NOW });
    const second = await s.owner.query(api.tasks.inbox, { now: NOW });
    expect(first.upcoming.map((t) => t.taskId)).toEqual(second.upcoming.map((t) => t.taskId));
  });

  test("finished work is out of the way unless asked for", async () => {
    const s = await setup();
    const { taskId } = await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId, title: "Already handled",
    });
    await s.owner.mutation(api.tasks.complete, { taskId, now: NOW });

    expect((await s.owner.query(api.tasks.inbox, { now: NOW })).done).toEqual([]);
    expect(
      (await s.owner.query(api.tasks.inbox, { includeDone: true, now: NOW })).done,
    ).toHaveLength(1);
  });
});

describe("a task cannot be filed where nobody will find it", () => {
  test("the venture filter actually filters", async () => {
    const s = await setup();
    await s.owner.mutation(api.tasks.create, { ventureId: s.ventureId, title: "Sites thing" });
    await s.owner.mutation(api.tasks.create, { ventureId: s.other, title: "Consulting thing" });

    const sites = await s.owner.query(api.tasks.inbox, { ventureId: s.ventureId, now: NOW });
    expect(sites.undated.map((t) => t.title)).toEqual(["Sites thing"]);

    const all = await s.owner.query(api.tasks.inbox, { now: NOW });
    expect(all.undated).toHaveLength(2);
  });

  test("a client from another venture is refused", async () => {
    // A task filed under the wrong venture is invisible to the person
    // filtering by the right one, which is the same as not existing.
    const s = await setup();
    const clientId = await s.h.run((ctx) =>
      ctx.db.insert("clients", {
        ventureId: s.other, kind: "external", name: "Salt Rock Cottage", status: "live",
        timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      }),
    );
    await expect(
      s.owner.mutation(api.tasks.create, {
        ventureId: s.ventureId, title: "Wrong venture", clientId,
      }),
    ).rejects.toThrow(/CLIENT_VENTURE_MISMATCH/);
  });

  test("a task needs a title you will recognise in a week", async () => {
    const s = await setup();
    for (const title of ["", " ", "x"]) {
      await expect(
        s.owner.mutation(api.tasks.create, { ventureId: s.ventureId, title }),
      ).rejects.toThrow(/INVALID/);
    }
  });

  test("it can point back at the LEAD it came out of", async () => {
    /*
     * The commonest task of all — "send them the quote on Thursday" — comes
     * out of a cold call, where there is no client yet. Without leadId it
     * would have nothing to point at.
     */
    const s = await setup();
    const leadId = await s.h.run((ctx) =>
      ctx.db.insert("leads", {
        ventureId: s.ventureId, businessName: "Upper Highway Solar", niche: "solar",
        phone: "+27671224453", auditFaults: [], status: "working",
        provenance: {
          source: "campaign_list", capturedAt: NOW,
          lawfulBasis: "legitimate_interest", detail: "SolarZA directory listing",
        },
      }),
    );
    const { taskId } = await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId,
      title: "Send Upper Highway the quote",
      leadId,
      dueAt: NOW + 2 * DAY,
    });
    const inbox = await s.owner.query(api.tasks.inbox, { now: NOW });
    expect(inbox.upcoming[0]?.leadId).toBe(leadId);
    void taskId;
  });

  test("an automation-made task says so, so it is explicable", async () => {
    // A task nobody remembers writing needs to be able to say where it came
    // from, or it gets deleted on sight.
    const s = await setup();
    await s.owner.mutation(api.tasks.create, {
      ventureId: s.ventureId,
      title: "Demo expires in 3 days",
      triggerKey: "demo.expiring",
    });
    const inbox = await s.owner.query(api.tasks.inbox, { now: NOW });
    expect(inbox.undated[0]?.triggerKey).toBe("demo.expiring");
  });
});
