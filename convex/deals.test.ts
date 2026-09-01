import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * THE PIPELINE.
 *
 * A forecast is only worth having if it cannot be quietly improved. Every
 * test here is an attempt to make the number look better than the facts —
 * by counting one conversation twice, by claiming a price nobody said, by
 * reopening something that closed badly, or by marking a lead converted when
 * no client exists.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

const SEP = Date.UTC(2026, 8, 2);
const R = (rands: number) => rands * 100;

async function setup(leads = 1) {
  const h = harness();
  const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
    email: "owner@thecreativecurrent.co.za",
  });
  const owner = asUser(h, userId);

  const ventureId = await h.run((ctx) =>
    ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    }),
  );

  const leadIds: Id<"leads">[] = [];
  for (let i = 0; i < leads; i++) {
    leadIds.push(
      await h.run((ctx) =>
        ctx.db.insert("leads", {
          ventureId,
          businessName: `Solar ${i + 1}`,
          niche: "solar",
          phone: `+2767122445${i}`,
          phoneDisplay: `067122445${i}`,
          area: "Hillcrest",
          auditFaults: [],
          status: "working",
          provenance: {
            source: "campaign_list",
            capturedAt: SEP,
            lawfulBasis: "legitimate_interest",
          },
        }),
      ),
    );
  }

  return { h, owner, ventureId, leadIds, leadId: leadIds[0]! };
}

/** Set a meeting on a call, which is what opens a deal. */
const meetingSet = (owner: ReturnType<typeof asUser>, leadId: Id<"leads">) =>
  owner.mutation(api.queue.disposition, { leadId, outcome: "meeting_set", now: SEP });

describe("a meeting set on a call opens a deal", () => {
  test("the disposition creates one, at demo_booked", async () => {
    const { h, owner, leadId } = await setup();

    const result = await meetingSet(owner, leadId);
    expect(result.dealId).not.toBeNull();

    const deals = await h.run((ctx) => ctx.db.query("deals").collect());
    expect(deals).toHaveLength(1);
    expect(deals[0]!.stage).toBe("demo_booked");
    expect(deals[0]!.leadId).toBe(leadId);
  });

  test("PHONING BACK AND RE-SETTING DOES NOT DOUBLE THE FORECAST", async () => {
    // The single most likely way this number gets inflated: the same
    // conversation recorded twice.
    const { h, owner, leadId } = await setup();

    const first = await meetingSet(owner, leadId);
    const second = await meetingSet(owner, leadId);

    expect(second.dealId).toBe(first.dealId);
    expect(await h.run((ctx) => ctx.db.query("deals").collect())).toHaveLength(1);
  });

  test("a deal starts with no value, because no price has been said", async () => {
    const { h, owner, leadId } = await setup();
    await meetingSet(owner, leadId);

    const deal = (await h.run((ctx) => ctx.db.query("deals").collect()))[0]!;
    expect(deal.valueCents).toBe(0);
    expect(deal.probability).toBe(0.1);
  });

  test("any other disposition opens nothing", async () => {
    const { h, owner, leadId } = await setup();
    await owner.mutation(api.queue.disposition, {
      leadId, outcome: "no_answer", now: SEP,
    });
    expect(await h.run((ctx) => ctx.db.query("deals").collect())).toHaveLength(0);
  });

  test("a prospect who said no, then later said yes, gets a NEW deal", async () => {
    const { h, owner, leadId } = await setup();
    const { dealId } = await meetingSet(owner, leadId);

    await owner.mutation(api.deals.advance, {
      dealId: dealId!, stage: "lost", lossReason: "Went with a cheaper quote", now: SEP,
    });

    const again = await meetingSet(owner, leadId);
    expect(again.dealId).not.toBe(dealId);
    expect(await h.run((ctx) => ctx.db.query("deals").collect())).toHaveLength(2);
  });
});

describe("each stage carries what makes it true", () => {
  test("PRICING PRESENTED REQUIRES THE PRICE", async () => {
    const { owner, leadId } = await setup();
    const { dealId } = await meetingSet(owner, leadId);

    await expect(
      owner.mutation(api.deals.advance, { dealId: dealId!, stage: "pricing_presented", now: SEP }),
    ).rejects.toThrow(/PRICING_NEEDS_A_NUMBER/);
  });

  test("with a price, it moves and the value sticks", async () => {
    const { h, owner, leadId } = await setup();
    const { dealId } = await meetingSet(owner, leadId);

    await owner.mutation(api.deals.advance, {
      dealId: dealId!, stage: "pricing_presented", valueCents: R(12_000), now: SEP,
    });

    const deal = (await h.run((ctx) => ctx.db.get(dealId!)))!;
    expect(deal.valueCents).toBe(1_200_000);
    expect(deal.probability).toBe(0.5);
  });

  test("LOST REQUIRES A REASON", async () => {
    const { owner, leadId } = await setup();
    const { dealId } = await meetingSet(owner, leadId);

    await expect(
      owner.mutation(api.deals.advance, { dealId: dealId!, stage: "lost", now: SEP }),
    ).rejects.toThrow(/LOSS_NEEDS_A_REASON/);

    await expect(
      owner.mutation(api.deals.advance, {
        dealId: dealId!, stage: "lost", lossReason: "   ", now: SEP,
      }),
    ).rejects.toThrow(/LOSS_NEEDS_A_REASON/);
  });

  test("a deal value must be whole cents", async () => {
    const { owner, leadId } = await setup();
    const { dealId } = await meetingSet(owner, leadId);

    await expect(
      owner.mutation(api.deals.advance, {
        dealId: dealId!, stage: "pricing_presented", valueCents: 1200.5, now: SEP,
      }),
    ).rejects.toThrow(/BAD_MONEY/);
  });
});

describe("closed is closed", () => {
  test.each(["won", "lost"] as const)("a %s deal cannot be moved again", async (stage) => {
    const { owner, leadId } = await setup();
    const { dealId } = await meetingSet(owner, leadId);

    await owner.mutation(api.deals.advance, {
      dealId: dealId!, stage, lossReason: stage === "lost" ? "Price" : undefined, now: SEP,
    });

    await expect(
      owner.mutation(api.deals.advance, { dealId: dealId!, stage: "verbal_commit", now: SEP }),
    ).rejects.toThrow(/DEAL_IS_CLOSED/);
  });

  test("closing stamps when, so the month it closed stays true", async () => {
    const { h, owner, leadId } = await setup();
    const { dealId } = await meetingSet(owner, leadId);

    await owner.mutation(api.deals.advance, { dealId: dealId!, stage: "won", now: SEP });
    expect((await h.run((ctx) => ctx.db.get(dealId!)))!.closedAt).toBe(SEP);
  });
});

describe("won is not converted", () => {
  test("WINNING DOES NOT MARK THE LEAD CONVERTED — no client exists yet", async () => {
    // A lead in the funnel's last column with nothing behind it would make
    // every count downstream wrong, in the direction that flatters us.
    const { h, owner, leadId } = await setup();
    const { dealId } = await meetingSet(owner, leadId);

    const result = await owner.mutation(api.deals.advance, {
      dealId: dealId!, stage: "won", now: SEP,
    });

    expect(result.conversionOwed).toBe(true);

    const lead = (await h.run((ctx) => ctx.db.get(leadId)))!;
    expect(lead.status).not.toBe("converted");
    expect(lead.convertedClientId).toBeUndefined();
  });
});

describe("the forecast", () => {
  test("weighted value is the price times the stage's probability", async () => {
    const { owner, leadIds } = await setup(2);

    const a = await meetingSet(owner, leadIds[0]!);
    await owner.mutation(api.deals.advance, {
      dealId: a.dealId!, stage: "pricing_presented", valueCents: R(10_000), now: SEP,
    });

    const b = await meetingSet(owner, leadIds[1]!);
    await owner.mutation(api.deals.advance, {
      dealId: b.dealId!, stage: "verbal_commit", valueCents: R(20_000), now: SEP,
    });

    const board = await owner.query(api.deals.board, {});
    // 10 000 × 0.5 + 20 000 × 0.8 = 21 000
    expect(board.openTotals).toEqual([
      { currency: "ZAR", valueCents: 3_000_000, weightedCents: 2_100_000 },
    ]);
  });

  test("a closed deal leaves the open forecast", async () => {
    const { owner, leadIds } = await setup(2);
    const a = await meetingSet(owner, leadIds[0]!);
    await owner.mutation(api.deals.advance, {
      dealId: a.dealId!, stage: "pricing_presented", valueCents: R(10_000), now: SEP,
    });
    await owner.mutation(api.deals.advance, {
      dealId: a.dealId!, stage: "lost", lossReason: "Too expensive", now: SEP,
    });

    const board = await owner.query(api.deals.board, {});
    expect(board.openTotals).toEqual([]);
    expect(board.stages.every((s) => s.stage !== "lost")).toBe(true);

    const withClosed = await owner.query(api.deals.board, { includeClosed: true });
    const lost = withClosed.stages.find((s) => s.stage === "lost")!;
    expect(lost.count).toBe(1);
    expect(lost.deals[0]!.lossReason).toBe("Too expensive");
  });

  test("the board never sums across currencies", async () => {
    const { h, owner, leadIds } = await setup(2);
    const a = await meetingSet(owner, leadIds[0]!);
    await owner.mutation(api.deals.advance, {
      dealId: a.dealId!, stage: "verbal_commit", valueCents: R(10_000), now: SEP,
    });
    const b = await meetingSet(owner, leadIds[1]!);
    await owner.mutation(api.deals.advance, {
      dealId: b.dealId!, stage: "verbal_commit", valueCents: R(500), now: SEP,
    });
    await h.run((ctx) => ctx.db.patch(b.dealId!, { currency: "USD" }));

    const board = await owner.query(api.deals.board, {});
    expect(board.openTotals).toHaveLength(2);
    expect(board.openTotals.map((t) => t.currency).sort()).toEqual(["USD", "ZAR"]);
  });

  test("the board carries the business name, so it reads as a pipeline", async () => {
    const { owner, leadId } = await setup();
    await meetingSet(owner, leadId);

    const board = await owner.query(api.deals.board, {});
    const booked = board.stages.find((s) => s.stage === "demo_booked")!;
    expect(booked.deals[0]!.businessName).toBe("Solar 1");
    expect(booked.deals[0]!.area).toBe("Hillcrest");
  });
});

describe("who may touch the pipeline", () => {
  test("an unauthenticated caller cannot read the board", async () => {
    const { h } = await setup();
    await expect(h.query(api.deals.board, {})).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("a client owner is not platform staff", async () => {
    const { h, owner, leadId } = await setup();
    const { dealId } = await meetingSet(owner, leadId);

    const tenantUser = await h.run(async (ctx) => {
      const venture = await ctx.db.query("ventures").first();
      const clientId = await ctx.db.insert("clients", {
        ventureId: venture!._id, kind: "platform", name: "Alpha", slug: "alpha",
        status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      });
      const userId = await ctx.db.insert("users", { email: "owner@alpha.test" });
      await ctx.db.insert("memberships", {
        userId, clientId, role: "owner", active: true, acceptedAt: SEP,
      });
      return userId;
    });

    await expect(asUser(h, tenantUser).query(api.deals.board, {})).rejects.toThrow(
      /platform access/,
    );
    await expect(
      asUser(h, tenantUser).mutation(api.deals.advance, {
        dealId: dealId!, stage: "won", now: SEP,
      }),
    ).rejects.toThrow(/platform access/);
  });
});
