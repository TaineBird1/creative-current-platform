import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { solarTradesTemplate, buildAccentRamp, safeParseSiteConfig } from "@cc/site-config";

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);

/**
 * A NOTICE AND A CONSENT ARE DIFFERENT THINGS, AND THE FORM HAS TO SAY SO.
 *
 * Answering an enquiry somebody submitted is necessary to conclude a contract
 * at their own request. It does not run on permission, so there is nothing
 * for them to accept — and the single required tickbox this replaces was a
 * permission that could not be declined, recorded as `lawfulBasis: "consent"`
 * on every row. A consent that cannot be refused is not one, so the basis was
 * false on the one field that exists to record it.
 *
 * Marketing is the half that genuinely is consent, and the only way it means
 * anything is if the form submits perfectly well without it.
 */

function build(withMarketing: boolean) {
  const base = solarTradesTemplate({
    businessName: "Example Solar", slug: "ex", brandColour: "#1f6f43",
    accent: buildAccentRamp("#1f6f43"), city: "Durban", region: "KwaZulu-Natal",
    suburb: "Hillcrest", addressLine: "12 Old Main Road", phone: "+27315551234",
    email: "hello@example.com",
  });
  if (withMarketing) return base;

  return {
    ...base,
    sections: base.sections.map((s) =>
      s.type === "quote" ? { ...s, marketingConsent: undefined } : s,
    ),
  };
}

async function site(withMarketing = true) {
  const h = harness();
  await h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Example Solar", slug: "ex",
      status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
      featureFlags: {}, isDemo: false, isSeed: false,
    });
    const config = build(withMarketing);
    await ctx.db.insert("sites", {
      clientId, slug: "ex", status: "live",
      config, publishedConfig: config, version: 1, configSchemaVersion: 1,
      isDemo: false,
    });
  });
  return h;
}

async function submit(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) {
  const { sectionId, answers } = await h.run(async (ctx) => {
    const row = (await ctx.db.query("sites").collect())[0]!;
    const parsed = safeParseSiteConfig(row.publishedConfig);
    if (!parsed.success) throw new Error("fixture config did not parse");
    const quote = parsed.data.sections.find((s) => s.type === "quote");
    if (!quote || quote.type !== "quote") throw new Error("no quote section");
    const a: Record<string, string> = {};
    for (const f of quote.fields) if (f.required && f.kind !== "photos") a[f.key] = "Yes";
    return { sectionId: quote.id, answers: a };
  });

  return h.mutation(api.public.quote.submit, {
    slug: "ex", sectionId, name: "Thandi M", phone: "0825551234", answers, ...extra,
  });
}

const stored = (h: ReturnType<typeof harness>) =>
  h.run(async (ctx) => (await ctx.db.query("quoteRequests").collect())[0]!);

describe("the notice is not a permission", () => {
  test("an enquiry submits with nothing accepted at all", async () => {
    // The whole correction, in one assertion: no consent argument, no refusal.
    const h = await site();
    const result = await submit(h);
    expect(result.recorded).toBe(true);
  });

  test("the row records CONTRACT, not consent", async () => {
    const h = await site();
    await submit(h);
    expect((await stored(h)).lawfulBasis).toBe("contract");
  });

  test("the notice shown is stored in the words on the page", async () => {
    const h = await site();
    await submit(h);
    const row = await stored(h);
    expect(row.noticeText).toContain("Example Solar");
    expect(row.noticeText.length).toBeGreaterThan(20);
  });

  /**
   * `apps/sites` and this backend deploy separately, so an already-published
   * bundle still sends `consentAccepted`. A validator that rejected it would
   * take every live enquiry form down for the length of that window.
   */
  test("a bundle still sending consentAccepted is accepted, not refused", async () => {
    const h = await site();
    await expect(submit(h, { consentAccepted: true })).resolves.toMatchObject({ recorded: true });
    const h2 = await site();
    await expect(submit(h2, { consentAccepted: false })).resolves.toMatchObject({ recorded: true });
  });
});

describe("marketing consent is the half that really is consent", () => {
  test("declining it does not block the enquiry", async () => {
    const h = await site();
    const result = await submit(h, { marketingOptIn: false });
    expect(result.recorded).toBe(true);
    expect((await stored(h)).marketingOptIn).toBe(false);
  });

  test("omitting it entirely reads as no", async () => {
    const h = await site();
    await submit(h);
    expect((await stored(h)).marketingOptIn).toBe(false);
  });

  test("ticking it is recorded with the words beside the box", async () => {
    const h = await site();
    await submit(h, { marketingOptIn: true });
    const row = await stored(h);
    expect(row.marketingOptIn).toBe(true);
    expect(row.marketingConsentText).toContain("Example Solar");
  });

  test("the wording is kept ONLY when it was ticked", async () => {
    // Declining leaves no permission to evidence, so there is no text to keep.
    const h = await site();
    await submit(h, { marketingOptIn: false });
    expect((await stored(h)).marketingConsentText).toBeUndefined();
  });

  /**
   * NO CONSENT ROW IS WRITTEN HERE, and that is not an omission.
   *
   * `consents.customerId` is required and an enquiry has no customer yet, so
   * there is nothing to attach one to. The table also has exactly two
   * permitted writers, held by a guard, because a third opinion about who may
   * be marketed to is the failure that guard exists to prevent. The tick is
   * kept as evidence; the row is written by `customers.ts` when a customer
   * first exists.
   */
  test("no consents row is written by an enquiry", async () => {
    const h = await site();
    await submit(h, { marketingOptIn: true });
    const rows = await h.run(async (ctx) => ctx.db.query("consents").collect());
    expect(rows).toEqual([]);
  });

  test("a client with no marketing configured stores no wording", async () => {
    const h = await site(false);
    await submit(h, { marketingOptIn: true });
    const row = await stored(h);
    // Ticked a box the config does not define: the flag is honest, and there
    // is no text to attribute to them.
    expect(row.marketingConsentText).toBeUndefined();
  });
});

describe("a config written before the split still parses", () => {
  /**
   * A stored config that fails to parse does not error visibly — the site
   * serves a HOLDING PAGE and every submission is refused. So a bare rename
   * of `consentText` would take a live client's site down at deploy, and the
   * only symptom would be a site that quietly stopped being theirs. Two rows
   * carried the old name when this was written.
   */
  test("legacy consentText is read as the notice", () => {
    const legacy = build(true);
    const withOldName = {
      ...legacy,
      sections: legacy.sections.map((s) => {
        if (s.type !== "quote") return s;
        const { noticeText, marketingConsent, ...rest } = s;
        return { ...rest, consentText: noticeText };
      }),
    };

    const parsed = safeParseSiteConfig(withOldName);
    expect(parsed.success, "a pre-split config must not blank the site").toBe(true);
    if (!parsed.success) return;

    const quote = parsed.data.sections.find((s) => s.type === "quote");
    expect(quote?.type === "quote" && quote.noticeText).toContain("Example Solar");
  });

  test("a new config is not disturbed by the shim", () => {
    const parsed = safeParseSiteConfig(build(true));
    expect(parsed.success).toBe(true);
  });
});
