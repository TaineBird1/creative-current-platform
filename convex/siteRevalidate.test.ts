import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { solarTradesTemplate, buildAccentRamp } from "@cc/site-config";
import type { Id } from "./_generated/dataModel";

/**
 * `apps/sites` does not query Convex per pageview — it caches resolution and
 * depends on being told when a site changes. Two things have to hold or that
 * trade goes bad in opposite directions:
 *
 *   - if the tags are wrong, sites serve stale content after a publish
 *   - if the tag SHAPE drifts from apps/sites/lib/site-cache.ts, revalidation
 *     silently hits nothing and nobody finds out until a client phones
 *
 * The tag strings are duplicated here on purpose. A test that derives them
 * from the implementation would pass through a rename that breaks the
 * contract with the other app.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const BRAND = "#1F6F4A";

const validConfig = () =>
  solarTradesTemplate({
    businessName: "Alpha Solar", slug: "alpha", brandColour: BRAND,
    // Derived, never hand-authored — the schema rejects a ramp that fails AA.
    accent: buildAccentRamp(BRAND),
    city: "Durban", region: "KwaZulu-Natal", suburb: "Hillcrest",
    addressLine: "1 Old Main Road", phone: "+27310000000",
  });

async function asOwner(h: Harness, clientId: Id<"clients">) {
  const userId = await h.run((ctx) => ctx.db.insert("users", { email: "owner@alpha.test" }));
  await h.run((ctx) =>
    ctx.db.insert("memberships", {
      userId, clientId, role: "owner", active: true, acceptedAt: Date.now(),
    }),
  );
  return h.withIdentity({ subject: `${userId}|test-session` });
}

async function seed(h: Harness) {
  return h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const clientId = await ctx.db.insert("clients", {
      ventureId, kind: "platform", name: "Alpha Solar", slug: "alpha", status: "live",
      timezone: "Africa/Johannesburg", currency: "ZAR",
      featureFlags: {}, isDemo: false, isSeed: false,
    });
    const siteId = await ctx.db.insert("sites", {
      clientId, slug: "alpha", status: "live", config: validConfig(),
      version: 1, configSchemaVersion: 1, isDemo: false,
    });
    return { clientId, siteId };
  });
}

const addDomain = (h: Harness, siteId: Id<"sites">, clientId: Id<"clients">, hostname: string) =>
  h.run((ctx) =>
    ctx.db.insert("domains", {
      siteId, clientId, hostname, isPrimary: true,
      verificationStatus: "verified", sslStatus: "issued",
    }),
  );

const tags = (h: Harness, siteId: Id<"sites">) =>
  h.query(internal.siteRevalidate.tagsForSite, { siteId });

describe("cache tags for a site", () => {
  test("a site with no custom domain is reachable by its slug alone", async () => {
    const h = harness();
    const { siteId } = await seed(h);
    expect(await tags(h, siteId)).toEqual(["site:slug:alpha"]);
  });

  test("every mapped domain gets a host tag, because a host lookup never learns the slug", async () => {
    const h = harness();
    const { siteId, clientId } = await seed(h);
    await addDomain(h, siteId, clientId, "alphasolar.co.za");
    await addDomain(h, siteId, clientId, "www.alphasolar.co.za");

    expect((await tags(h, siteId)).sort()).toEqual([
      "site:host:alphasolar.co.za",
      "site:host:www.alphasolar.co.za",
      "site:slug:alpha",
    ]);
  });

  test("tags are lowercased, because Host headers are not", async () => {
    const h = harness();
    const { siteId, clientId } = await seed(h);
    await addDomain(h, siteId, clientId, "AlphaSolar.CO.ZA");
    expect(await tags(h, siteId)).toContain("site:host:alphasolar.co.za");
  });

  test("every tag is namespaced, because the revalidate route rejects anything else", async () => {
    const h = harness();
    const { siteId, clientId } = await seed(h);
    await addDomain(h, siteId, clientId, "alphasolar.co.za");
    for (const tag of await tags(h, siteId)) expect(tag.startsWith("site:")).toBe(true);
  });

  test("a deleted site yields no tags rather than throwing", async () => {
    const h = harness();
    const { siteId } = await seed(h);
    await h.run((ctx) => ctx.db.delete(siteId));
    expect(await tags(h, siteId)).toEqual([]);
  });
});

describe("revalidation is scheduled by the writes that change what a visitor sees", () => {
  /*
   * Fake timers go on BEFORE anything is scheduled, which is the order the
   * convex-test docs use and the only order that works.
   *
   * The failure this guards against is a race, not a logic error.
   * `runAfter(0, ...)` fires the moment the mutation commits; if the test ends
   * first, convex-test runs the action against a torn-down harness and throws
   * "Write outside of transaction ..._scheduled_functions". It passed locally
   * every single time and only failed under CI's timing.
   *
   * `finishInProgressScheduledFunctions` is not enough on its own — it drains
   * what is already running, and a job scheduled for +0ms is still pending.
   */
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const jobs = (h: Harness) =>
    h.run(async (ctx) => {
      const all = await ctx.db.system.query("_scheduled_functions").collect();
      return all.filter((j) => j.name.includes("siteRevalidate"));
    });

  const drain = (h: Harness) => h.finishAllScheduledFunctions(vi.runAllTimers);

  test("publish enqueues a revalidation, and it runs to completion", async () => {
    const h = harness();
    const { siteId, clientId } = await seed(h);
    const owner = await asOwner(h, clientId);

    expect(await jobs(h)).toHaveLength(0);

    await owner.mutation(api.siteConfigs.publish, { clientSlug: "alpha", siteId });

    // Without this, a publish would look successful while every visitor kept
    // getting the previous config until the fallback window expired.
    expect(await jobs(h)).toHaveLength(1);

    await drain(h);

    // The row survives completion carrying its outcome, so assert the outcome
    // rather than its absence. "failed" would mean a publish silently stopped
    // revalidating — and it would mean SITES_REVALIDATE_URL being unset takes
    // the write down with it, which is the one thing this must never do.
    expect((await jobs(h)).map((j) => j.state.kind)).toEqual(["success"]);
  });

  test("replace enqueues one too, so an editor save is not invisible", async () => {
    const h = harness();
    const { siteId, clientId } = await seed(h);
    const owner = await asOwner(h, clientId);

    await owner.mutation(api.siteConfigs.replace, {
      clientSlug: "alpha", siteId, config: validConfig(), expectedVersion: 1,
    });

    expect(await jobs(h)).toHaveLength(1);

    await drain(h);
    expect((await jobs(h)).map((j) => j.state.kind)).toEqual(["success"]);
  });

  test("the action does not throw when the sites app is not configured", async () => {
    const h = harness();
    const { siteId } = await seed(h);
    // SITES_REVALIDATE_URL is unset under test. A missing hook must degrade to
    // a warning, never an unhandled rejection in a scheduled function — a
    // publish that already committed must not surface as a failure.
    await expect(
      h.action(internal.siteRevalidate.revalidateSite, { siteId }),
    ).resolves.toBeNull();
  });
});
