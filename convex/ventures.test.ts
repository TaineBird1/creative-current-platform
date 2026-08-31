import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * VENTURES + EXTERNAL CLIENTS (Part 5.1–5.2).
 *
 * The guarantee worth testing is not "the form saves". It is that an external
 * client can never become a tenant by accident. `app.<domain>/c/<slug>`
 * resolves on slug alone, so a slug on a consulting client would mint a back
 * office nobody sold, for a client with nowhere to sign in, reachable by
 * anyone who guessed the URL.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

/** An authenticated platform OWNER, via the one bootstrap that mints the first. */
async function withOwner(h: Harness) {
  const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
    email: "owner@thecreativecurrent.co.za",
  });
  return asUser(h, userId);
}

const PLATFORM = { name: "Sites", type: "platform" as const, currency: "ZAR" as const };

describe("ventures", () => {
  test("creates one, and lists it with its client counts", async () => {
    const h = harness();
    const owner = await withOwner(h);

    const { ventureId } = await owner.mutation(api.ventures.create, PLATFORM);
    expect(ventureId).toBeTruthy();

    const rows = await owner.query(api.ventures.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Sites",
      type: "platform",
      active: true,
      clientCount: 0,
      liveClientCount: 0,
    });
  });

  test("refuses a duplicate name regardless of case", async () => {
    // "Sites" and "sites" in a switcher splits a P&L in half silently.
    const h = harness();
    const owner = await withOwner(h);
    await owner.mutation(api.ventures.create, PLATFORM);

    await expect(
      owner.mutation(api.ventures.create, { ...PLATFORM, name: "  sITES  ", type: "consulting" }),
    ).rejects.toThrow(/DUPLICATE_VENTURE/);
  });

  test("refuses a SECOND platform venture", async () => {
    const h = harness();
    const owner = await withOwner(h);
    await owner.mutation(api.ventures.create, PLATFORM);

    await expect(
      owner.mutation(api.ventures.create, { ...PLATFORM, name: "Sites 2" }),
    ).rejects.toThrow(/PLATFORM_VENTURE_EXISTS/);
  });

  test("an operator cannot mint a venture — it is a reporting boundary", async () => {
    const h = harness();
    const owner = await withOwner(h);

    const operatorId = await h.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "op@thecreativecurrent.co.za" });
      await ctx.db.insert("platformMembers", { userId, role: "operator", active: true });
      return userId;
    });

    await expect(
      asUser(h, operatorId).mutation(api.ventures.create, PLATFORM),
    ).rejects.toThrow();

    // ...but they can still READ, or every list in the console is meaningless.
    await owner.mutation(api.ventures.create, PLATFORM);
    await expect(asUser(h, operatorId).query(api.ventures.list, {})).resolves.toHaveLength(1);
  });

  test("archiving is refused while live clients still belong to it", async () => {
    const h = harness();
    const owner = await withOwner(h);
    const { ventureId } = await owner.mutation(api.ventures.create, {
      name: "Consulting", type: "consulting", currency: "ZAR",
    });
    await owner.mutation(api.clients.createExternal, {
      ventureId, name: "Zenith", currency: "ZAR",
    });

    await expect(
      owner.mutation(api.ventures.setActive, { ventureId, active: false }),
    ).rejects.toThrow(/VENTURE_HAS_LIVE_CLIENTS/);
  });

  test("an archived venture leaves the switcher but keeps its history", async () => {
    // Archive, never delete: ledger entries point at a venture forever.
    const h = harness();
    const owner = await withOwner(h);
    const { ventureId } = await owner.mutation(api.ventures.create, {
      name: "Property", type: "property", currency: "ZAR",
    });

    await owner.mutation(api.ventures.setActive, { ventureId, active: false });

    await expect(owner.query(api.ventures.list, {})).resolves.toHaveLength(0);
    await expect(
      owner.query(api.ventures.list, { includeArchived: true }),
    ).resolves.toHaveLength(1);

    const still = await h.run((ctx) => ctx.db.get(ventureId));
    expect(still).not.toBeNull();
  });
});

describe("external clients", () => {
  async function ventureFor(h: Harness, owner: ReturnType<typeof asUser>) {
    const { ventureId } = await owner.mutation(api.ventures.create, {
      name: "Consulting", type: "consulting", currency: "ZAR",
    });
    return ventureId;
  }

  test("NEVER gets a slug — the back office resolves on slug alone", async () => {
    const h = harness();
    const owner = await withOwner(h);
    const ventureId = await ventureFor(h, owner);

    const { clientId } = await owner.mutation(api.clients.createExternal, {
      ventureId, name: "Zenith Freight", currency: "ZAR",
    });

    const client = await h.run((ctx) => ctx.db.get(clientId));
    expect(client?.kind).toBe("external");
    // Absent, not "" — an empty string is still a resolvable key.
    expect(client?.slug).toBeUndefined();

    /*
     * And nothing reaches it by slug, which is the actual guarantee. Asserted
     * with a length check first: `.every()` on an empty array is true, so
     * without it this passes vacuously the day the query stops matching.
     */
    const slugless = await h.run((ctx) =>
      ctx.db.query("clients").withIndex("by_slug", (q) => q.eq("slug", undefined)).collect(),
    );
    expect(slugless).toHaveLength(1);
    expect(slugless[0]!._id).toBe(clientId);
    expect(slugless.every((c) => c.kind === "external")).toBe(true);
  });

  test("gets no feature set — there is no console to render one into", async () => {
    const h = harness();
    const owner = await withOwner(h);
    const ventureId = await ventureFor(h, owner);

    const { clientId } = await owner.mutation(api.clients.createExternal, {
      ventureId, name: "Zenith Freight", currency: "ZAR",
    });

    const client = await h.run((ctx) => ctx.db.get(clientId));
    expect(client?.featureFlags).toEqual({});
    expect(client?.isDemo).toBe(false);
    expect(client?.isSeed).toBe(false);
  });

  test("refuses an unknown or archived venture", async () => {
    const h = harness();
    const owner = await withOwner(h);
    const ventureId = await ventureFor(h, owner);

    await owner.mutation(api.ventures.setActive, { ventureId, active: false });
    await expect(
      owner.mutation(api.clients.createExternal, { ventureId, name: "Late", currency: "ZAR" }),
    ).rejects.toThrow(/VENTURE_ARCHIVED/);
  });

  test("the client list filters by venture and carries the venture through", async () => {
    const h = harness();
    const owner = await withOwner(h);
    const consulting = await ventureFor(h, owner);
    const { ventureId: property } = await owner.mutation(api.ventures.create, {
      name: "Property", type: "property", currency: "ZAR",
    });

    await owner.mutation(api.clients.createExternal, {
      ventureId: consulting, name: "Zenith Freight", currency: "ZAR",
    });
    await owner.mutation(api.clients.createExternal, {
      ventureId: property, name: "Salt Rock Cottage", currency: "ZAR",
    });

    const all = await owner.query(api.clients.list, {});
    expect(all).toHaveLength(2);

    const onlyProperty = await owner.query(api.clients.list, { ventureId: property });
    expect(onlyProperty).toHaveLength(1);
    expect(onlyProperty[0]).toMatchObject({
      name: "Salt Rock Cottage",
      kind: "external",
      ventureName: "Property",
      ventureType: "property",
    });
  });

  test("creating one is audit-logged against its venture", async () => {
    const h = harness();
    const owner = await withOwner(h);
    const ventureId = await ventureFor(h, owner);
    await owner.mutation(api.clients.createExternal, {
      ventureId, name: "Zenith Freight", currency: "ZAR",
    });

    const entries = await h.run((ctx) => ctx.db.query("auditLog").collect());
    const created = entries.find((e) => e.action === "client.createExternal");
    expect(created?.ventureId).toBe(ventureId);
    expect(created?.clientId).toBeTruthy();
  });
});
