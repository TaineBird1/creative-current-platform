import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { setReseller } from "./lib/reseller";
import type { Id } from "./_generated/dataModel";

/**
 * RESELLER DEPTH IS EXACTLY 1 -- as a check, not a convention.
 *
 * requireTenant walks memberships exactly one hop down. These tests are what
 * makes that hop correct: at depth 2 the walk silently stops being complete,
 * and a cycle would hang the resolver.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);

async function seed(h: ReturnType<typeof harness>) {
  return h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const mk = (name: string, slug: string) =>
      ctx.db.insert("clients", {
        ventureId, kind: "platform", name, slug, status: "live",
        timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      });
    return {
      agency: await mk("Agency", "agency"),
      client: await mk("Client", "client"),
      grandchild: await mk("Grandchild", "grandchild"),
    };
  });
}

describe("reseller depth", () => {
  test("depth 1 is allowed", async () => {
    const h = harness();
    const s = await seed(h);

    await h.run((ctx) => setReseller(ctx, s.client, s.agency));

    const client = await h.run((ctx) => ctx.db.get(s.client));
    expect(client!.resellerId).toBe(s.agency);
  });

  test("a client that HAS a reseller cannot BE one", async () => {
    const h = harness();
    const s = await seed(h);

    await h.run((ctx) => setReseller(ctx, s.client, s.agency));

    // grandchild -> client -> agency would be depth 2.
    await expect(
      h.run((ctx) => setReseller(ctx, s.grandchild, s.client)),
    ).rejects.toThrow(/max depth 1/);

    const grandchild = await h.run((ctx) => ctx.db.get(s.grandchild));
    expect(grandchild!.resellerId).toBeUndefined();
  });

  test("a client that IS a reseller cannot gain one", async () => {
    const h = harness();
    const s = await seed(h);

    await h.run((ctx) => setReseller(ctx, s.client, s.agency));

    // agency already has a downstream client; giving it a parent is depth 2.
    await expect(
      h.run((ctx) => setReseller(ctx, s.agency, s.grandchild)),
    ).rejects.toThrow(/max depth 1/);
  });

  test("a client cannot resell itself", async () => {
    const h = harness();
    const s = await seed(h);

    await expect(
      h.run((ctx) => setReseller(ctx, s.agency, s.agency)),
    ).rejects.toThrow(/cannot resell itself/);
  });

  test("a two-client cycle is impossible", async () => {
    const h = harness();
    const s = await seed(h);

    await h.run((ctx) => setReseller(ctx, s.client, s.agency));

    // A -> B already exists; B -> A would close the loop.
    await expect(
      h.run((ctx) => setReseller(ctx, s.agency, s.client)),
    ).rejects.toThrow(/max depth 1/);
  });

  test("clearing a reseller frees the client to become one", async () => {
    const h = harness();
    const s = await seed(h);

    await h.run((ctx) => setReseller(ctx, s.client, s.agency));
    await h.run((ctx) => setReseller(ctx, s.client, null));
    await h.run((ctx) => setReseller(ctx, s.grandchild, s.client));

    const grandchild = await h.run((ctx) => ctx.db.get(s.grandchild));
    expect(grandchild!.resellerId).toBe(s.client);
  });

  test("an unknown reseller is rejected", async () => {
    const h = harness();
    const s = await seed(h);
    const bogus = "kn700000000000000000000000000000" as Id<"clients">;

    await expect(h.run((ctx) => setReseller(ctx, s.client, bogus))).rejects.toThrow();
  });
});
