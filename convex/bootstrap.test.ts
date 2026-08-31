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

  /*
   * This used to assert NO_SUCH_USER — "sign in once first". That is
   * impossible on a fresh deployment and deadlocked it: resolveSignIn refuses
   * an unknown email without a pending invite, and an invite needs a
   * createdBy user that does not exist yet. The old test passed while the
   * product could not be set up at all.
   */
  test("CREATES the account when there is none — a fresh deployment has no users", async () => {
    const h = harness();

    const result = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "First@TheCreativeCurrent.co.za",
    });
    expect(result.role).toBe("owner");
    expect(result.email).toBe("first@thecreativecurrent.co.za");

    const user = await h.run((ctx) => ctx.db.get(result.userId));
    expect(user?.email).toBe("first@thecreativecurrent.co.za");
    // The OTP flow verifies the address. Asserting it here would be a lie.
    expect(user?.emailVerificationTime).toBeUndefined();
  });

  test("the created account can actually reach the platform", async () => {
    // The whole point: a bare user row that cannot reach anything is the bug.
    const h = harness();
    const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "first@thecreativecurrent.co.za",
    });

    await expect(asUser(h, userId).query(api.platform.me, {})).resolves.toEqual({
      role: "owner",
    });
  });

  test("still refuses a second claim, even though it now creates accounts", async () => {
    // Creating users must not turn this into an open privilege escalation.
    const h = harness();
    await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "first@thecreativecurrent.co.za",
    });

    await expect(
      h.mutation(internal.bootstrap.claimPlatformOwner, { email: "attacker@example.test" }),
    ).rejects.toThrow(/ALREADY_BOOTSTRAPPED/);

    const users = await h.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1); // and it did NOT leave a user row behind
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
