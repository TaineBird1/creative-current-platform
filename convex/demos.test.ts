import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { safeParseSiteConfig } from "@cc/site-config";

/**
 * THE DEMO PIPELINE.
 *
 * A demo is a working site carrying a real business's name and suburb, sent
 * to somebody who did not ask for it. Every failure here is a page that looks
 * completely fine and should not exist — which is why the tests are about
 * what is NOT on it as much as what is.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

const AUG = Date.UTC(2026, 7, 25);

async function setup(lead: Partial<{ businessName: string; area: string; phone: string }> = {}) {
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
  const leadId = await h.run((ctx) =>
    ctx.db.insert("leads", {
      ventureId,
      businessName: lead.businessName ?? "Upper Highway Solar",
      niche: "solar",
      phone: lead.phone ?? "+27671224453",
      phoneDisplay: "0671224453",
      area: lead.area ?? "Hillcrest",
      website: "uhsolar.co.za",
      auditFaults: ["No HTTPS", "No phone above the fold"],
      status: "new",
      provenance: {
        source: "campaign_list",
        capturedAt: AUG,
        lawfulBasis: "legitimate_interest",
        detail: "SolarZA directory listing (Hillcrest)",
      },
    }),
  );
  return { h, owner, ventureId, leadId };
}

describe("a demo is built from what the lead actually says", () => {
  test("it carries their name, their suburb and their own number", async () => {
    const s = await setup();
    const demo = await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });

    expect(demo.slug).toBe("upper-highway-solar");
    expect(demo.path).toBe("/upper-highway-solar");

    const site = await s.h.run((ctx) => ctx.db.get(demo.siteId));
    const parsed = safeParseSiteConfig(site!.publishedConfig);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.brand.name).toBe("Upper Highway Solar");
    expect(parsed.data.locations[0]?.suburb).toBe("Hillcrest");
    // Their published number, not one we made up.
    expect(parsed.data.locations[0]?.phone).toBe("+27671224453");
  });

  test("NO street address is invented", async () => {
    /*
     * The whole reason `addressLine` is optional in the config schema. A
     * directory listing gives a suburb; printing a made-up street under a
     * real business's name is the exact harm the demo rules exist for, and it
     * would arrive through a schema default rather than a decision.
     */
    const s = await setup();
    const demo = await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    const site = await s.h.run((ctx) => ctx.db.get(demo.siteId));
    const parsed = safeParseSiteConfig(site!.publishedConfig);
    if (!parsed.success) return;
    expect(parsed.data.locations[0]?.addressLine).toBeUndefined();
  });

  test("the slug is theirs, so the link does not read as spam", async () => {
    // A stranger's WhatsApp with a random-looking URL does not get opened.
    const s = await setup({ businessName: "B&K Solar (Pty) Ltd" });
    const demo = await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    expect(demo.slug).toBe("b-k-solar-pty-ltd");
  });

  test("two businesses with the same name get distinct slugs", async () => {
    const first = await setup({ businessName: "KZN Solar" });
    const demoOne = await first.owner.mutation(api.demos.createForLead, {
      leadId: first.leadId, now: AUG,
    });
    const secondLeadId = await first.h.run((ctx) =>
      ctx.db.insert("leads", {
        ventureId: first.ventureId,
        businessName: "KZN Solar",
        niche: "solar",
        phone: "+27825550002",
        area: "Pinetown",
        auditFaults: [],
        status: "new",
        provenance: {
          source: "campaign_list", capturedAt: AUG,
          lawfulBasis: "legitimate_interest", detail: "ENF Solar directory listing",
        },
      }),
    );
    const demoTwo = await first.owner.mutation(api.demos.createForLead, {
      leadId: secondLeadId, now: AUG,
    });
    expect(demoOne.slug).toBe("kzn-solar");
    expect(demoTwo.slug).toBe("kzn-solar-2");
  });
});

describe("a demo cannot be built for someone who said no", () => {
  test("a suppressed lead is refused", async () => {
    /*
     * Building a demo is outreach. Doing it for a business that asked not to
     * be contacted is the same act as calling them, so it goes through the
     * same check and fails closed for the same reason.
     */
    const s = await setup();
    await s.h.run((ctx) =>
      ctx.db.insert("suppressions", {
        kind: "phone", value: "0671224453",
        reason: "asked not to be contacted", createdAt: AUG,
      }),
    );
    await expect(
      s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG }),
    ).rejects.toThrow(/SUPPRESSED/);

    // And nothing was half-created.
    expect(await s.h.run((ctx) => ctx.db.query("sites").collect())).toEqual([]);
    expect(await s.h.run((ctx) => ctx.db.query("clients").collect())).toEqual([]);
  });

  test("a second demo for the same lead is refused, not silently duplicated", async () => {
    // Two demos for one business is two links in the wild, one of which
    // nobody is tracking.
    const s = await setup();
    await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    await expect(
      s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG }),
    ).rejects.toThrow(/DEMO_EXISTS/);
  });
});

describe("the demo is safe by construction", () => {
  test("it is created with an expiry and the demo flag", async () => {
    const s = await setup();
    const demo = await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    const site = await s.h.run((ctx) => ctx.db.get(demo.siteId));
    expect(site?.isDemo).toBe(true);
    expect(site?.demoExpiresAt).toBe(AUG + 30 * 24 * 60 * 60 * 1000);
  });

  test("the CLIENT is marked demo, which is what blocks money and messages", async () => {
    /*
     * Not a cosmetic flag. lib/ledger.ts refuses to post against a demo
     * client and lib/messaging.ts refuses to send to one, so a demo cannot
     * be invoiced or messaged whatever anybody later wires up.
     */
    const s = await setup();
    const demo = await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    const client = await s.h.run((ctx) => ctx.db.get(demo.clientId));
    expect(client?.isDemo).toBe(true);

    await expect(
      s.owner.mutation(api.invoices.issue, {
        clientId: demo.clientId,
        lineItems: [{ description: "Website", quantity: 1, unitPriceCents: 100 }],
      }),
    ).rejects.toThrow(/NOT_A_REAL_CLIENT/);
  });

  test("it resolves publicly, with the demo context the renderer requires", async () => {
    const s = await setup();
    const demo = await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    const resolved = await s.h.query(api.public.site.resolve, { slug: demo.slug });
    expect(resolved.kind).toBe("site");
    if (resolved.kind !== "site") return;
    expect(resolved.isDemo).toBe(true);
    // Non-null, or SiteRenderer throws rather than draw it.
    expect(resolved.demo?.subjectName).toBe("Upper Highway Solar");
  });

  test("the lead is marked demo_sent so the queue stops offering it as new", async () => {
    const s = await setup();
    await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    const lead = await s.h.run((ctx) => ctx.db.get(s.leadId));
    expect(lead?.status).toBe("demo_sent");
  });
});

describe("expiry is managed, not left to rot", () => {
  test("extending runs from TODAY, not from the old expiry", async () => {
    /*
     * A prospect who asks for another week on the last day wants a week —
     * not a week measured from when the demo was built, which is already
     * spent.
     */
    const s = await setup();
    const demo = await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    const later = AUG + 29 * 24 * 60 * 60 * 1000;
    const { expiresAt } = await s.owner.mutation(api.demos.extend, {
      siteId: demo.siteId, days: 7, now: later,
    });
    expect(expiresAt).toBe(later + 7 * 24 * 60 * 60 * 1000);
  });

  test("revoking takes it down but keeps the slug claimed", async () => {
    /*
     * Deleting the site would free the slug, and a link already sent would
     * later resolve to a DIFFERENT business's demo. Expiring it serves the
     * notice instead.
     */
    const s = await setup();
    const demo = await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    await s.owner.mutation(api.demos.revoke, { siteId: demo.siteId, now: AUG });

    const resolved = await s.h.query(api.public.site.resolve, { slug: demo.slug });
    expect(resolved.kind).toBe("holding");
    if (resolved.kind !== "holding") return;
    expect(resolved.reason).toBe("demo_expired");

    // The row is still there, so the slug cannot be handed to anyone else.
    expect(await s.h.run((ctx) => ctx.db.query("sites").collect())).toHaveLength(1);
  });

  test("neither extend nor revoke will touch a real client's site", async () => {
    const s = await setup();
    const realSiteId = await s.h.run(async (ctx) => {
      const clientId = await ctx.db.insert("clients", {
        ventureId: s.ventureId, kind: "platform", name: "Real Client", slug: "real",
        status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      });
      return ctx.db.insert("sites", {
        clientId, slug: "real", status: "live", config: {}, version: 1,
        configSchemaVersion: 1, isDemo: false,
      });
    });

    await expect(
      s.owner.mutation(api.demos.revoke, { siteId: realSiteId }),
    ).rejects.toThrow(/NOT_A_DEMO/);
    await expect(
      s.owner.mutation(api.demos.extend, { siteId: realSiteId }),
    ).rejects.toThrow(/NOT_A_DEMO/);
  });

  test("the list shows what is going dark, soonest first", async () => {
    const s = await setup();
    await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    const rows = await s.owner.query(api.demos.list, { now: AUG });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.businessName).toBe("Upper Highway Solar");
    expect(rows[0]?.expiresInDays).toBe(30);
    expect(rows[0]?.expired).toBe(false);
  });

  test("an expired demo reports NEGATIVE days rather than clamping to zero", async () => {
    // "Went dark 6 days ago" and "expires today" are different situations and
    // only one of them needs a call.
    const s = await setup();
    const demo = await s.owner.mutation(api.demos.createForLead, { leadId: s.leadId, now: AUG });
    const rows = await s.owner.query(api.demos.list, {
      now: AUG + 36 * 24 * 60 * 60 * 1000,
    });
    expect(rows[0]?.siteId).toBe(demo.siteId);
    expect(rows[0]?.expired).toBe(true);
    expect(rows[0]?.expiresInDays).toBe(-6);
  });
});
