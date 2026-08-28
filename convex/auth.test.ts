import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { resolveSignIn, hashToken, INVITE_TTL_MS } from "./lib/invites";
import type { Id } from "./_generated/dataModel";

/**
 * INVITE-ONLY MUST HOLD.
 *
 * `resolveSignIn` is the only place a users row is created, so it is the only
 * place this rule has to be enforced — and therefore the only place worth
 * attacking. Every test here is an attempt to get an account without an
 * invite, or to mint privilege at or above your own.
 *
 * Never relax one of these to make a sign-in flow work.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

async function seed(h: Harness) {
  return h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites", type: "platform", currency: "ZAR", active: true, sortOrder: 1,
    });
    const mkClient = (name: string, slug: string) =>
      ctx.db.insert("clients", {
        ventureId, kind: "platform", name, slug, status: "live",
        timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      });
    const alphaId = await mkClient("Alpha Solar", "alpha");
    const bravoId = await mkClient("Bravo Solar", "bravo");

    const mkLocation = (clientId: Id<"clients">, name: string) =>
      ctx.db.insert("locations", {
        clientId, name, addressLine: "1 Main Rd", suburb: "Hillcrest",
        city: "Durban", region: "KwaZulu-Natal", countryCode: "ZA",
        timezone: "Africa/Johannesburg", active: true,
      });
    const alphaMain = await mkLocation(alphaId, "Alpha Main");
    const alphaSecond = await mkLocation(alphaId, "Alpha Second");

    const alphaOwner = await ctx.db.insert("users", { email: "owner@alpha.test" });
    await ctx.db.insert("memberships", {
      userId: alphaOwner, clientId: alphaId, role: "owner",
      active: true, acceptedAt: Date.now(),
    });

    return { ventureId, alphaId, bravoId, alphaMain, alphaSecond, alphaOwner };
  });
}

const inviteFor = async (
  h: Harness,
  email: string,
  fields: Record<string, unknown> = {},
) =>
  h.run(async (ctx) => {
    const s = await ctx.db.query("clients").withIndex("by_slug", (q) => q.eq("slug", "alpha")).unique();
    const creator = await ctx.db.query("users").first();
    return ctx.db.insert("invites", {
      clientId: s!._id,
      tenantRole: "staff",
      email,
      channel: "whatsapp",
      tokenHash: await hashToken("plaintext-token"),
      expiresAt: Date.now() + INVITE_TTL_MS,
      createdBy: creator!._id,
      ...fields,
    });
  });

describe("the sign-in gate", () => {
  test("a stranger with no invite gets no account at all", async () => {
    const h = harness();
    await seed(h);

    await expect(
      h.run((ctx) => resolveSignIn(ctx, { existingUserId: null, email: "stranger@example.test" })),
    ).rejects.toThrow(/NOT_INVITED/);

    // Not merely refused — nothing was written.
    const users = await h.run((ctx) => ctx.db.query("users").collect());
    expect(users.some((u) => u.email === "stranger@example.test")).toBe(false);
  });

  test("an invited email gets a user AND a membership, together", async () => {
    const h = harness();
    const s = await seed(h);
    await inviteFor(h, "newstaff@alpha.test");

    const userId = await h.run((ctx) =>
      resolveSignIn(ctx, { existingUserId: null, email: "newstaff@alpha.test" }),
    );

    const membership = await h.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user_client", (q) => q.eq("userId", userId).eq("clientId", s.alphaId))
        .unique(),
    );
    expect(membership?.role).toBe("staff");
    expect(membership?.active).toBe(true);
  });

  test("email case and whitespace do not create a second account", async () => {
    const h = harness();
    await seed(h);
    await inviteFor(h, "mixed@alpha.test");

    const first = await h.run((ctx) =>
      resolveSignIn(ctx, { existingUserId: null, email: "  MiXeD@Alpha.TEST " }),
    );
    const second = await h.run((ctx) =>
      resolveSignIn(ctx, { existingUserId: null, email: "mixed@alpha.test" }),
    );
    expect(second).toBe(first);
  });

  test("an expired invite is refused", async () => {
    const h = harness();
    await seed(h);
    await inviteFor(h, "late@alpha.test", { expiresAt: Date.now() - 1000 });

    await expect(
      h.run((ctx) => resolveSignIn(ctx, { existingUserId: null, email: "late@alpha.test" })),
    ).rejects.toThrow(/NOT_INVITED/);
  });

  test("a revoked invite is refused", async () => {
    const h = harness();
    await seed(h);
    await inviteFor(h, "revoked@alpha.test", { revokedAt: Date.now() });

    await expect(
      h.run((ctx) => resolveSignIn(ctx, { existingUserId: null, email: "revoked@alpha.test" })),
    ).rejects.toThrow(/NOT_INVITED/);
  });

  test("an invite is single use", async () => {
    const h = harness();
    await seed(h);
    const inviteId = await inviteFor(h, "once@alpha.test");

    await h.run((ctx) => resolveSignIn(ctx, { existingUserId: null, email: "once@alpha.test" }));

    const invite = await h.run((ctx) => ctx.db.get(inviteId));
    expect(invite?.acceptedAt).toBeDefined();

    // Wipe the access it granted, then try to ride the same invite back in.
    await h.run(async (ctx) => {
      for (const m of await ctx.db.query("memberships").collect()) {
        if (m.acceptedAt === invite?.acceptedAt) await ctx.db.delete(m._id);
      }
    });

    await expect(
      h.run((ctx) => resolveSignIn(ctx, { existingUserId: null, email: "once@alpha.test" })),
    ).rejects.toThrow(/NOT_INVITED/);
  });

  test("an invite that grants nothing leaves no user behind", async () => {
    const h = harness();
    await seed(h);
    // Neither a tenant role nor a platform role: malformed.
    await inviteFor(h, "empty@alpha.test", { clientId: undefined, tenantRole: undefined });

    await expect(
      h.run((ctx) => resolveSignIn(ctx, { existingUserId: null, email: "empty@alpha.test" })),
    ).rejects.toThrow(/NOT_INVITED/);

    const users = await h.run((ctx) => ctx.db.query("users").collect());
    expect(users.some((u) => u.email === "empty@alpha.test")).toBe(false);
  });

  test("a user whose access was revoked cannot sign back in", async () => {
    const h = harness();
    const s = await seed(h);

    await h.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", s.alphaOwner).eq("active", true))
        .unique();
      await ctx.db.patch(m!._id, { active: false });
    });

    await expect(
      h.run((ctx) => resolveSignIn(ctx, { existingUserId: s.alphaOwner, email: "owner@alpha.test" })),
    ).rejects.toThrow(/NOT_INVITED/);
  });

  test("an existing user invited to a SECOND client gets it on next sign-in", async () => {
    const h = harness();
    const s = await seed(h);

    await h.run(async (ctx) => {
      await ctx.db.insert("invites", {
        clientId: s.bravoId,
        tenantRole: "manager",
        email: "owner@alpha.test",
        channel: "email",
        tokenHash: await hashToken("t2"),
        expiresAt: Date.now() + INVITE_TTL_MS,
        createdBy: s.alphaOwner,
      });
    });

    await h.run((ctx) =>
      resolveSignIn(ctx, { existingUserId: s.alphaOwner, email: "owner@alpha.test" }),
    );

    const memberships = await h.run((ctx) =>
      ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", s.alphaOwner).eq("active", true)).collect(),
    );
    expect(memberships).toHaveLength(2);
    expect(memberships.find((m) => m.clientId === s.bravoId)?.role).toBe("manager");
  });

  test("a platform invite grants platform access, not a tenant membership", async () => {
    const h = harness();
    const s = await seed(h);
    await h.run(async (ctx) => {
      await ctx.db.insert("invites", {
        platformRole: "operator",
        email: "op@thecreativecurrent.co.za",
        channel: "email",
        tokenHash: await hashToken("t3"),
        expiresAt: Date.now() + INVITE_TTL_MS,
        createdBy: s.alphaOwner,
      });
    });

    const userId = await h.run((ctx) =>
      resolveSignIn(ctx, { existingUserId: null, email: "op@thecreativecurrent.co.za" }),
    );

    const platform = await h.run((ctx) =>
      ctx.db.query("platformMembers").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
    );
    expect(platform?.role).toBe("operator");

    const memberships = await h.run((ctx) =>
      ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId).eq("active", true)).collect(),
    );
    expect(memberships).toHaveLength(0);
  });
});

describe("minting privilege", () => {
  test("an owner cannot invite another owner", async () => {
    const h = harness();
    const s = await seed(h);

    await expect(
      asUser(h, s.alphaOwner).mutation(api.invites.inviteToClient, {
        clientSlug: "alpha", email: "coup@alpha.test", role: "owner", channel: "whatsapp",
      }),
    ).rejects.toThrow(/cannot invite a owner/);
  });

  test("an owner can invite a manager", async () => {
    const h = harness();
    const s = await seed(h);

    const result = await asUser(h, s.alphaOwner).mutation(api.invites.inviteToClient, {
      clientSlug: "alpha", email: "mgr@alpha.test", role: "manager", channel: "whatsapp",
    });
    expect(result.token).toHaveLength(64);
  });

  test("the plaintext token is never stored", async () => {
    const h = harness();
    const s = await seed(h);

    const { token, inviteId } = await asUser(h, s.alphaOwner).mutation(
      api.invites.inviteToClient,
      { clientSlug: "alpha", email: "hash@alpha.test", role: "staff", channel: "whatsapp" },
    );

    const invite = await h.run((ctx) => ctx.db.get(inviteId));
    expect(invite!.tokenHash).not.toBe(token);
    expect(invite!.tokenHash).toBe(await hashToken(token));
  });

  test("a manager cannot invite another manager", async () => {
    const h = harness();
    const s = await seed(h);
    const mgr = await h.run(async (ctx) => {
      const mgr = await ctx.db.insert("users", { email: "mgr@alpha.test" });
      await ctx.db.insert("memberships", {
        userId: mgr, clientId: s.alphaId, role: "manager",
        locationId: s.alphaMain, active: true, acceptedAt: Date.now(),
      });
      return mgr;
    });

    await expect(
      asUser(h, mgr).mutation(api.invites.inviteToClient, {
        clientSlug: "alpha", email: "peer@alpha.test", role: "manager", channel: "whatsapp",
      }),
    ).rejects.toThrow(/cannot invite a manager/);
  });

  test("a manager cannot invite into another branch", async () => {
    const h = harness();
    const s = await seed(h);
    const mgr = await h.run(async (ctx) => {
      const mgr = await ctx.db.insert("users", { email: "mgr2@alpha.test" });
      await ctx.db.insert("memberships", {
        userId: mgr, clientId: s.alphaId, role: "manager",
        locationId: s.alphaMain, active: true, acceptedAt: Date.now(),
      });
      return mgr;
    });

    await expect(
      asUser(h, mgr).mutation(api.invites.inviteToClient, {
        clientSlug: "alpha", email: "elsewhere@alpha.test", role: "staff",
        channel: "whatsapp", locationId: s.alphaSecond,
      }),
    ).rejects.toThrow(/own branch/);
  });

  test("staff cannot invite anyone", async () => {
    const h = harness();
    const s = await seed(h);
    const staff = await h.run(async (ctx) => {
      const staff = await ctx.db.insert("users", { email: "staff@alpha.test" });
      await ctx.db.insert("memberships", {
        userId: staff, clientId: s.alphaId, role: "staff", active: true, acceptedAt: Date.now(),
      });
      return staff;
    });

    await expect(
      asUser(h, staff).mutation(api.invites.inviteToClient, {
        clientSlug: "alpha", email: "friend@alpha.test", role: "staff", channel: "whatsapp",
      }),
    ).rejects.toThrow(/role:manager/);
  });

  test("an owner cannot invite into another tenant", async () => {
    const h = harness();
    const s = await seed(h);

    await expect(
      asUser(h, s.alphaOwner).mutation(api.invites.inviteToClient, {
        clientSlug: "bravo", email: "trespass@bravo.test", role: "staff", channel: "whatsapp",
      }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("an owner cannot revoke another tenant's invite", async () => {
    const h = harness();
    const s = await seed(h);
    const bravoInvite = await h.run(async (ctx) =>
      ctx.db.insert("invites", {
        clientId: s.bravoId, tenantRole: "staff", email: "b@bravo.test",
        channel: "email", tokenHash: await hashToken("t4"),
        expiresAt: Date.now() + INVITE_TTL_MS, createdBy: s.alphaOwner,
      }),
    );

    await expect(
      asUser(h, s.alphaOwner).mutation(api.invites.revoke, {
        clientSlug: "alpha", inviteId: bravoInvite,
      }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("listing invites never leaks the token hash", async () => {
    const h = harness();
    const s = await seed(h);
    await asUser(h, s.alphaOwner).mutation(api.invites.inviteToClient, {
      clientSlug: "alpha", email: "listed@alpha.test", role: "staff", channel: "whatsapp",
    });

    const listed = await asUser(h, s.alphaOwner).query(api.invites.listForClient, {
      clientSlug: "alpha",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("tokenHash");
    expect(listed[0]!.state).toBe("pending");
  });
});
