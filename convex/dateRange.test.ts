import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { solarTradesTemplate, buildAccentRamp } from "@cc/site-config";

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);

/**
 * THE SERVER OWNS THE SHAPE OF A DATE RANGE, NOT THE BROWSER.
 *
 * Every other field kind is a string, and a string is what gets stored, so
 * "not empty" is the whole of the check. A `dateRange` is different: it is
 * stored as a value something later has to READ — a guest house books from
 * it — and the commonest malformed value a real form produces is TRUTHY.
 *
 * Somebody picks a departure, gets distracted, and submits. The answer is
 * `2027-07-12/`, the required check sees a non-empty string and passes it,
 * and an unparseable range is written to `quoteRequests` where it looks
 * answered. These tests are the reason the shape check exists beside the
 * presence check rather than instead of it.
 */

async function siteWithDateRange() {
  const h = harness();

  await h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Champagne Example", slug: "champ",
      status: "live", timezone: "Africa/Johannesburg", currency: "ZAR",
      featureFlags: {}, isDemo: false, isSeed: false,
    });

    const base = solarTradesTemplate({
      businessName: "Champagne Example", slug: "champ", brandColour: "#1f6f43",
      accent: buildAccentRamp("#1f6f43"), city: "Durban", region: "KwaZulu-Natal",
      suburb: "Hillcrest", addressLine: "12 Old Main Road", phone: "+27315551234",
    });

    /*
     * The template's own quote section, with a dateRange field added — rather
     * than a hand-built config, so this exercises the same parse path a real
     * site takes.
     */
    const config = {
      ...base,
      sections: base.sections.map((section) =>
        section.type === "quote"
          ? {
              ...section,
              fields: [
                ...section.fields,
                {
                  key: "travelDates",
                  label: "Travel dates",
                  kind: "dateRange" as const,
                  required: true,
                },
              ],
            }
          : section,
      ),
    };

    await ctx.db.insert("sites", {
      clientId, slug: "champ", status: "live",
      config, publishedConfig: config, version: 1, configSchemaVersion: 1,
      isDemo: false,
    });
  });

  return h;
}

async function submit(h: ReturnType<typeof harness>, travelDates: string) {
  const sectionId = await h.run(async (ctx) => {
    const site = (await ctx.db.query("sites").collect())[0]!;
    const cfg = site.publishedConfig as { sections: { id: string; type: string }[] };
    return cfg.sections.find((s) => s.type === "quote")!.id;
  });

  const answers: Record<string, string> = { travelDates };
  // Every other required field satisfied, so a refusal can only be about the
  // range — otherwise a passing test proves nothing about this check.
  const required = await h.run(async (ctx) => {
    const site = (await ctx.db.query("sites").collect())[0]!;
    const cfg = site.publishedConfig as {
      sections: { id: string; type: string; fields?: { key: string; kind: string; required?: boolean }[] }[];
    };
    const quote = cfg.sections.find((s) => s.type === "quote")!;
    return (quote.fields ?? []).filter((f) => f.required && f.kind !== "photos" && f.kind !== "dateRange");
  });
  for (const field of required) answers[field.key] = "Yes";

  return h.mutation(api.public.quote.submit, {
    slug: "champ",
    sectionId,
    name: "Thandi M",
    phone: "0825551234",
    answers,
    consentAccepted: true,
  });
}

describe("a date range is validated on the server", () => {
  test("a valid range is accepted and stored verbatim", async () => {
    const h = await siteWithDateRange();
    const result = await submit(h, "2027-07-12/2027-07-19");
    expect(result.recorded).toBe(true);

    const stored = await h.run(async (ctx) => (await ctx.db.query("quoteRequests").collect())[0]!);
    expect(stored.answers.travelDates).toBe("2027-07-12/2027-07-19");
  });

  /**
   * THE ONE THE PRESENCE CHECK LETS THROUGH. `"2027-07-12/"` is a non-empty
   * string, so `field.required && !supplied` is false and it would be written
   * unchallenged. If this test ever passes with the shape check removed, the
   * check has stopped doing anything.
   */
  test("a half-picked range is refused, though it is not empty", async () => {
    const h = await siteWithDateRange();
    await expect(submit(h, "2027-07-12/")).rejects.toThrow(/start date and an end date/i);

    const count = await h.run(async (ctx) => (await ctx.db.query("quoteRequests").collect()).length);
    expect(count, "a refused submission must write nothing").toBe(0);
  });

  test("a return before the departure is refused", async () => {
    const h = await siteWithDateRange();
    await expect(submit(h, "2027-07-19/2027-07-12")).rejects.toThrow(/start date and an end date/i);
  });

  test("a day that does not exist is refused", async () => {
    // Date.parse accepts it and returns 2 March; the round trip is what says no.
    const h = await siteWithDateRange();
    await expect(submit(h, "2027-02-30/2027-03-05")).rejects.toThrow(/start date and an end date/i);
  });

  test("free text is refused, which is what the field replaces", async () => {
    const h = await siteWithDateRange();
    await expect(submit(h, "sometime in July")).rejects.toThrow(/start date and an end date/i);
  });

  test("an empty required range is refused as missing, not as malformed", async () => {
    // The two refusals say different things and a customer needs the right one.
    const h = await siteWithDateRange();
    await expect(submit(h, "")).rejects.toThrow(/is required/i);
  });

  test("a past range is ACCEPTED, because refusing loses the enquiry", async () => {
    const h = await siteWithDateRange();
    const result = await submit(h, "2020-01-01/2020-01-08");
    expect(result.recorded).toBe(true);
  });
});
