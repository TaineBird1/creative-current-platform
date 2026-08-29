import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * The bootstrap grants PLATFORM OWNERSHIP, the highest privilege in the
 * system, from an internal mutation anyone with deployment access can run.
 * The only thing making that acceptable is that it refuses once an owner
 * exists. These tests are that guarantee.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

const mkUser = (h: Harness, email: string) =>
  h.run((ctx) => ctx.db.insert("users", { email }));

describe("bootstrapping the first platform owner", () => {
  test("grants ownership when there is none", async () => {
    const h = harness();
    const userId = await mkUser(h, "owner@thecreativecurrent.co.za");

    const result = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    expect(result.role).toBe("owner");

    const member = await h.run((ctx) =>
      ctx.db.query("platformMembers").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
    );
    expect(member?.role).toBe("owner");
    expect(member?.active).toBe(true);
  });

  test("REFUSES once an owner exists — it disarms itself", async () => {
    const h = harness();
    await mkUser(h, "first@thecreativecurrent.co.za");
    await mkUser(h, "second@thecreativecurrent.co.za");

    await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "first@thecreativecurrent.co.za",
    });

    await expect(
      h.mutation(internal.bootstrap.claimPlatformOwner, {
        email: "second@thecreativecurrent.co.za",
      }),
    ).rejects.toThrow(/ALREADY_BOOTSTRAPPED/);
  });

  test("a deactivated owner does not keep the door shut forever", async () => {
    // Otherwise losing the only owner account bricks the platform.
    const h = harness();
    const first = await mkUser(h, "first@thecreativecurrent.co.za");
    await mkUser(h, "second@thecreativecurrent.co.za");

    await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "first@thecreativecurrent.co.za",
    });
    await h.run(async (ctx) => {
      const m = await ctx.db
        .query("platformMembers")
        .withIndex("by_user", (q) => q.eq("userId", first))
        .unique();
      await ctx.db.patch(m!._id, { active: false });
    });

    await expect(
      h.mutation(internal.bootstrap.claimPlatformOwner, {
        email: "second@thecreativecurrent.co.za",
      }),
    ).resolves.toMatchObject({ role: "owner" });
  });

  test("refuses an email with no account", async () => {
    const h = harness();
    await expect(
      h.mutation(internal.bootstrap.claimPlatformOwner, { email: "ghost@example.test" }),
    ).rejects.toThrow(/NO_SUCH_USER/);
  });

  test("the grant is written to the audit log", async () => {
    const h = harness();
    await mkUser(h, "owner@thecreativecurrent.co.za");
    await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });

    const entries = await h.run((ctx) => ctx.db.query("auditLog").collect());
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("platform.bootstrapOwner");
  });
});

describe("platform.me", () => {
  test("a tenant owner is NOT platform staff", async () => {
    const h = harness();
    const { tenantUser } = await h.run(async (ctx) => {
      const ventureId = await ctx.db.insert("ventures", {
        name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
      });
      const clientId = await ctx.db.insert("clients", {
        ventureId, kind: "platform", name: "Alpha", slug: "alpha", status: "live",
        timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      });
      const tenantUser = await ctx.db.insert("users", { email: "owner@alpha.test" });
      await ctx.db.insert("memberships", {
        userId: tenantUser, clientId, role: "owner", active: true, acceptedAt: Date.now(),
      });
      return { tenantUser };
    });

    // Holds a real session and owns a business — still cannot reach /admin.
    await expect(
      asUser(h, tenantUser).query(api.platform.me, {}),
    ).rejects.toThrow(/platform access/);
  });

  test("a bootstrapped owner is", async () => {
    const h = harness();
    const userId = await mkUser(h, "owner@thecreativecurrent.co.za");
    await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });

    await expect(asUser(h, userId).query(api.platform.me, {})).resolves.toEqual({
      role: "owner",
    });
  });

  test("a deactivated platform member is refused", async () => {
    const h = harness();
    const userId = await mkUser(h, "ex@thecreativecurrent.co.za");
    await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "ex@thecreativecurrent.co.za",
    });
    await h.run(async (ctx) => {
      const m = await ctx.db
        .query("platformMembers")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      await ctx.db.patch(m!._id, { active: false });
    });

    await expect(asUser(h, userId).query(api.platform.me, {})).rejects.toThrow(
      /platform access/,
    );
  });
});
