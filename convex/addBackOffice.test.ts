import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildAccentRamp, safeParseSiteConfig } from "@cc/site-config";

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

/**
 * ONBOARDING A CLIENT WHOSE WEBSITE IS SOMEBODY ELSE'S.
 *
 * The two things this must NOT do are the two `convertWonDeal` does: touch a
 * deal that does not exist, and issue an invoice for a fee already paid
 * outside the platform. The second is the expensive one — a second document
 * for one payment is the harm the invoice-numbering rule exists to prevent.
 */

async function setup() {
  const h = harness();
  const { userId, ventureId } = await h.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@example.com" });
    await ctx.db.insert("platformMembers", { userId, role: "owner", active: true });
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    return { userId, ventureId };
  });
  return { h, userId, ventureId };
}

const ARGS = (ventureId: Id<"ventures">, over: Record<string, unknown> = {}) => ({
  ventureId,
  businessName: "Example Holidays",
  slug: "example-holidays",
  ownerEmail: "info@example.com",
  brandColour: "#1f6f43",
  accent: buildAccentRamp("#1f6f43"),
  externalSiteUrl: "https://example-holidays.example.com",
  locations: [
    { id: "main", name: "Head office", suburb: "Midrand", city: "Midrand", region: "Gauteng" },
  ],
  enquiry: {
    heading: "Plan your trip",
    fields: [
      { key: "country", label: "Country", kind: "select" as const, required: true, options: ["Italy", "France"] },
      { key: "travelDates", label: "Travel dates", kind: "dateRange" as const, required: true },
      { key: "adults", label: "Adults", kind: "number" as const, required: true },
    ],
    noticeText:
      "Example Holidays will use these details to answer this enquiry and nothing else.",
    marketingConsentText:
      "Tick this if Example Holidays may also send you occasional offers and news.",
  },
  ...over,
});

describe("a back office without a website of ours", () => {
  test("creates a platform client with a slug and quotes on", async () => {
    const { h, userId, ventureId } = await setup();
    const result = await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    const client = await h.run(async (ctx) => ctx.db.get(result.clientId));
    expect(client?.kind).toBe("platform");
    expect(client?.slug).toBe("example-holidays");
    expect(client?.featureFlags).toEqual({ quotes: true });
    expect(client?.isDemo).toBe(false);
    expect(client?.isSeed).toBe(false);
  });

  /**
   * THE WHOLE REASON THIS EXISTS RATHER THAN convertWonDeal. The build fee was
   * invoiced and paid outside the platform; a second document bearing a
   * different number for the same payment is unrecoverable confusion.
   */
  test("issues NO invoice and allocates no number", async () => {
    const { h, userId, ventureId } = await setup();
    await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    const invoices = await h.run(async (ctx) => ctx.db.query("invoices").collect());
    expect(invoices, "onboarding must bill nobody").toEqual([]);
  });

  test("touches no deal and converts no lead", async () => {
    const { h, userId, ventureId } = await setup();
    await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    const deals = await h.run(async (ctx) => ctx.db.query("deals").collect());
    const leads = await h.run(async (ctx) => ctx.db.query("leads").collect());
    expect(deals).toEqual([]);
    expect(leads).toEqual([]);
  });

  test("mints an owner invite and reports whether it was delivered", async () => {
    const { h, userId, ventureId } = await setup();
    const result = await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    const invite = await h.run(async (ctx) => ctx.db.get(result.inviteId));
    expect(invite?.tenantRole).toBe("owner");
    expect(invite?.email).toBe("info@example.com");
    // Reported rather than assumed: an unconfigured allowlist HOLDS this, and
    // a screen saying "invited" over a held message is the failure to avoid.
    expect(result.inviteDelivery).toBeDefined();
  });
});

describe("the site declares the form and is never served", () => {
  test("the site is draft with NO publishedConfig", async () => {
    const { h, userId, ventureId } = await setup();
    const result = await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    const site = await h.run(async (ctx) => ctx.db.get(result.siteId));
    expect(site?.status).toBe("draft");
    // The load-bearing assertion: public/site.ts answers an absent
    // publishedConfig with a holding page, so this row cannot become a second
    // wrong copy of the client's real website.
    expect(site?.publishedConfig, "an unpublished config is what keeps it unserved").toBeUndefined();
  });

  test("public/site refuses to serve it", async () => {
    const { h, userId, ventureId } = await setup();
    await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    const served = await h.query(api.public.site.resolve, { slug: "example-holidays" });
    expect(served.kind).toBe("holding");
  });

  test("but the enquiry form works, from the unpublished config", async () => {
    const { h, userId, ventureId } = await setup();
    const created = await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    const result = await h.mutation(api.public.quote.submit, {
      slug: "example-holidays",
      sectionId: created.enquirySectionId,
      name: "Thandi M",
      phone: "0825551234",
      answers: { country: "Italy", travelDates: "2027-07-12/2027-07-19", adults: "2" },
    });

    expect(result.recorded).toBe(true);
    const row = await h.run(async (ctx) => (await ctx.db.query("quoteRequests").collect())[0]!);
    expect(row.clientId).toBe(created.clientId);
    expect(row.lawfulBasis).toBe("contract");
    expect(row.answers.travelDates).toBe("2027-07-12/2027-07-19");
  });

  test("the server enforces the declared fields, not the browser", async () => {
    const { h, userId, ventureId } = await setup();
    const created = await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    await expect(
      h.mutation(api.public.quote.submit, {
        slug: "example-holidays",
        sectionId: created.enquirySectionId,
        name: "Thandi M",
        phone: "0825551234",
        // A half-picked range: truthy, and unusable.
        answers: { country: "Italy", travelDates: "2027-07-12/", adults: "2" },
      }),
    ).rejects.toThrow(/start date and an end date/i);
  });

  test("the stored config carries the notice and the marketing wording", async () => {
    const { h, userId, ventureId } = await setup();
    const created = await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    const site = await h.run(async (ctx) => ctx.db.get(created.siteId));
    const parsed = safeParseSiteConfig(site?.config);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const quote = parsed.data.sections.find((s) => s.type === "quote");
    expect(quote?.type === "quote" && quote.noticeText).toContain("Example Holidays");
    expect(quote?.type === "quote" && quote.marketingConsent?.text).toContain("occasional offers");
    expect(parsed.data.features.booking, "they sell no appointments").toBe(false);
    expect(parsed.data.features.quotes).toBe(true);
  });
});

describe("it refuses rather than guessing", () => {
  /**
   * `freeSlug` suffixes, which is right for a machine deriving one from a
   * business name and wrong for one a person typed: onboarding
   * `example-holidays-2` hands them a sign-in URL nobody was told about.
   */
  test("a taken slug is refused, not suffixed", async () => {
    const { h, userId, ventureId } = await setup();
    await asUser(h, userId).mutation(api.onboarding.addBackOffice, ARGS(ventureId));

    await expect(
      asUser(h, userId).mutation(
        api.onboarding.addBackOffice,
        ARGS(ventureId, { businessName: "Another Example", ownerEmail: "two@example.com" }),
      ),
    ).rejects.toThrow(/already in use/i);

    const clients = await h.run(async (ctx) => ctx.db.query("clients").collect());
    expect(clients).toHaveLength(1);
  });

  test("an enquiry form with no fields is refused", async () => {
    const { h, userId, ventureId } = await setup();
    await expect(
      asUser(h, userId).mutation(
        api.onboarding.addBackOffice,
        ARGS(ventureId, { enquiry: { ...ARGS(ventureId).enquiry, fields: [] } }),
      ),
    ).rejects.toThrow(/at least one field/i);
  });

  test("a refusal writes nothing at all", async () => {
    // One serializable transaction: a client with no site is a back office
    // that can never receive an enquiry.
    const { h, userId, ventureId } = await setup();
    await expect(
      asUser(h, userId).mutation(
        api.onboarding.addBackOffice,
        ARGS(ventureId, { enquiry: { ...ARGS(ventureId).enquiry, fields: [] } }),
      ),
    ).rejects.toThrow();

    const clients = await h.run(async (ctx) => ctx.db.query("clients").collect());
    const sites = await h.run(async (ctx) => ctx.db.query("sites").collect());
    const invites = await h.run(async (ctx) => ctx.db.query("invites").collect());
    expect([clients.length, sites.length, invites.length]).toEqual([0, 0, 0]);
  });

  test("a non-owner cannot call it", async () => {
    const { h, ventureId } = await setup();
    const stranger = await h.run(async (ctx) =>
      ctx.db.insert("users", { email: "stranger@example.com" }),
    );
    await expect(
      asUser(h, stranger).mutation(api.onboarding.addBackOffice, ARGS(ventureId)),
    ).rejects.toThrow();
  });
});
