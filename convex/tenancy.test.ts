import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * CROSS-TENANT ACCESS MUST FAIL.
 *
 * This file is the contract. It goes red the moment anyone reintroduces a
 * clientId-from-args path, softens the membership walk, or lets an id from
 * one tenant resolve under another. Do not weaken an assertion here to make a
 * feature pass -- the assertion IS the feature.
 *
 * Run: pnpm vitest run convex/tenancy.test.ts
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

/** Convex Auth encodes the identity subject as `${userId}|${sessionId}`. */
const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

async function seedTwoTenants(h: Harness) {
  return h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "The Creative Current · Sites",
      type: "platform",
      currency: "ZAR",
      active: true,
      sortOrder: 1,
    });

    const mkClient = async (name: string, slug: string) =>
      ctx.db.insert("clients", {
        ventureId,
        kind: "platform",
        name,
        slug,
        status: "live",
        timezone: "Africa/Johannesburg",
        currency: "ZAR",
        featureFlags: {},
        isDemo: false,
        isSeed: false,
      });

    const alphaId = await mkClient("Alpha Solar", "alpha");
    const bravoId = await mkClient("Bravo Solar", "bravo");

    const mkSite = async (clientId: Id<"clients">, slug: string) =>
      ctx.db.insert("sites", {
        clientId,
        slug,
        status: "live",
        config: {},
        version: 1,
        configSchemaVersion: 1,
        isDemo: false,
      });

    const alphaSite = await mkSite(alphaId, "alpha");
    const bravoSite = await mkSite(bravoId, "bravo");

    const mkUser = (email: string) => ctx.db.insert("users", { email });

    const alphaOwner = await mkUser("owner@alpha.test");
    const bravoOwner = await mkUser("owner@bravo.test");
    const stranger = await mkUser("nobody@example.test"); // bare user row

    const mkMembership = (
      userId: Id<"users">,
      clientId: Id<"clients">,
      role: "owner" | "manager" | "staff",
    ) =>
      ctx.db.insert("memberships", {
        userId,
        clientId,
        role,
        active: true,
        acceptedAt: Date.now(),
      });

    await mkMembership(alphaOwner, alphaId, "owner");
    await mkMembership(bravoOwner, bravoId, "owner");

    const mkRequest = (clientId: Id<"clients">, siteId: Id<"sites">, name: string) =>
      ctx.db.insert("quoteRequests", {
        clientId,
        siteId,
        name,
        phone: "+27820000000",
        answers: {},
        photoStorageIds: [],
        status: "new",
        consentText: "I agree to be contacted about this enquiry.",
        lawfulBasis: "consent",
        submittedAt: Date.now(),
        isDemo: false,
      });

    const alphaRequest = await mkRequest(alphaId, alphaSite, "Alpha Customer");
    const bravoRequest = await mkRequest(bravoId, bravoSite, "Bravo Customer");

    return {
      ventureId, alphaId, bravoId, alphaSite, bravoSite,
      alphaOwner, bravoOwner, stranger, alphaRequest, bravoRequest,
    };
  });
}

describe("cross-tenant access", () => {
  test("Alpha's owner cannot list Bravo's quote requests by slug", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);

    await expect(
      asUser(h, s.alphaOwner).query(api.quoteRequests.list, { clientSlug: "bravo" }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("an unauthorised slug is indistinguishable from a nonexistent one", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);
    const alpha = asUser(h, s.alphaOwner);

    const unauthorised = await alpha
      .query(api.quoteRequests.list, { clientSlug: "bravo" })
      .then(() => "RESOLVED", (e: Error) => e.message);
    const nonexistent = await alpha
      .query(api.quoteRequests.list, { clientSlug: "does-not-exist" })
      .then(() => "RESOLVED", (e: Error) => e.message);

    // Identical, or tenant enumeration is possible.
    expect(unauthorised).toEqual(nonexistent);
    expect(unauthorised).not.toEqual("RESOLVED");
  });

  test("a record id from another tenant does not resolve", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);

    // Correct slug, someone else's document id. This is the attack a naive
    // `ctx.db.get(id)` lets straight through.
    await expect(
      asUser(h, s.alphaOwner).query(api.quoteRequests.get, {
        clientSlug: "alpha",
        requestId: s.bravoRequest,
      }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("a mutation cannot touch another tenant's record", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);

    await expect(
      asUser(h, s.alphaOwner).mutation(api.quoteRequests.setStatus, {
        clientSlug: "alpha",
        requestId: s.bravoRequest,
        status: "lost",
      }),
    ).rejects.toThrow(/NOT_FOUND/);

    const after = await h.run((ctx) => ctx.db.get(s.bravoRequest));
    expect(after?.status).toBe("new");
  });

  test("a bare user row with no membership reaches nothing", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);

    await expect(
      asUser(h, s.stranger).query(api.quoteRequests.list, { clientSlug: "alpha" }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("an unauthenticated caller reaches nothing", async () => {
    const h = harness();
    await seedTwoTenants(h);

    await expect(
      h.query(api.quoteRequests.list, { clientSlug: "alpha" }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
  });

  test("a deactivated membership stops working immediately", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);

    await h.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_user_client", (q) =>
          q.eq("userId", s.alphaOwner).eq("clientId", s.alphaId),
        )
        .unique();
      await ctx.db.patch(m!._id, { active: false });
    });

    await expect(
      asUser(h, s.alphaOwner).query(api.quoteRequests.list, { clientSlug: "alpha" }),
    ).rejects.toThrow(/NOT_FOUND/);
  });
});

describe("role scoping", () => {
  test("staff cannot change a request's status (manager minimum)", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);

    const staffUser = await h.run(async (ctx) => {
      const staffUser = await ctx.db.insert("users", { email: "staff@alpha.test" });
      await ctx.db.insert("memberships", {
        userId: staffUser, clientId: s.alphaId, role: "staff",
        active: true, acceptedAt: Date.now(),
      });
      return staffUser;
    });

    await expect(
      asUser(h, staffUser).mutation(api.quoteRequests.setStatus, {
        clientSlug: "alpha", requestId: s.alphaRequest, status: "contacted",
      }),
    ).rejects.toThrow(/role:manager/);
  });

  test("staff see that work exists but not the customer's contact details", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);

    const staffUser = await h.run(async (ctx) => {
      const staffUser = await ctx.db.insert("users", { email: "staff2@alpha.test" });
      await ctx.db.insert("memberships", {
        userId: staffUser, clientId: s.alphaId, role: "staff",
        active: true, acceptedAt: Date.now(),
      });
      return staffUser;
    });

    const rows = await asUser(h, staffUser).query(api.quoteRequests.list, {
      clientSlug: "alpha",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phone).toBeNull();

    const ownerRows = await asUser(h, s.alphaOwner).query(api.quoteRequests.list, {
      clientSlug: "alpha",
    });
    expect(ownerRows[0]!.phone).toBe("+27820000000");
  });
});

describe("slug aliases", () => {
  test("a retired slug still resolves, and reports the canonical one", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);

    await h.run(async (ctx) => {
      await ctx.db.patch(s.alphaId, { slug: "alpha-energy" });
      await ctx.db.insert("clientSlugAliases", {
        slug: "alpha", clientId: s.alphaId, createdAt: Date.now(),
      });
    });

    // The installed PWA still asks for /c/alpha. It must keep working.
    await expect(
      asUser(h, s.alphaOwner).query(api.quoteRequests.list, { clientSlug: "alpha" }),
    ).resolves.toHaveLength(1);

    await expect(
      asUser(h, s.alphaOwner).query(api.quoteRequests.list, { clientSlug: "alpha-energy" }),
    ).resolves.toHaveLength(1);
  });

  test("an alias does NOT grant access across tenants", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);

    await h.run(async (ctx) => {
      await ctx.db.insert("clientSlugAliases", {
        slug: "old-bravo", clientId: s.bravoId, createdAt: Date.now(),
      });
    });

    await expect(
      asUser(h, s.alphaOwner).query(api.quoteRequests.list, { clientSlug: "old-bravo" }),
    ).rejects.toThrow(/NOT_FOUND/);
  });
});

describe("white-label reseller", () => {
  async function seedAgencies(h: Harness, s: Awaited<ReturnType<typeof seedTwoTenants>>) {
    return h.run(async (ctx) => {
      const mkAgency = (name: string, slug: string) =>
        ctx.db.insert("clients", {
          ventureId: s.ventureId, kind: "platform", name, slug, status: "live",
          timezone: "Africa/Johannesburg", currency: "ZAR",
          featureFlags: {}, isDemo: false, isSeed: false,
        });
      const agency = await mkAgency("Agency One", "agency-one");
      const rival = await mkAgency("Agency Two", "agency-two");
      await ctx.db.patch(s.alphaId, { resellerId: agency });

      const agencyOwner = await ctx.db.insert("users", { email: "owner@agency-one.test" });
      const rivalOwner = await ctx.db.insert("users", { email: "owner@agency-two.test" });
      await ctx.db.insert("memberships", {
        userId: agencyOwner, clientId: agency, role: "owner", active: true, acceptedAt: Date.now(),
      });
      await ctx.db.insert("memberships", {
        userId: rivalOwner, clientId: rival, role: "owner", active: true, acceptedAt: Date.now(),
      });
      return { agency, rival, agencyOwner, rivalOwner };
    });
  }

  test("an agency owner reaches its own downstream client, and no other", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);
    const a = await seedAgencies(h, s);

    await expect(
      asUser(h, a.agencyOwner).query(api.quoteRequests.list, { clientSlug: "alpha" }),
    ).resolves.toHaveLength(1);

    await expect(
      asUser(h, a.rivalOwner).query(api.quoteRequests.list, { clientSlug: "alpha" }),
    ).rejects.toThrow(/NOT_FOUND/);

    // Bravo has no reseller at all.
    await expect(
      asUser(h, a.agencyOwner).query(api.quoteRequests.list, { clientSlug: "bravo" }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("an agency is capped at manager tier downstream", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);
    const a = await seedAgencies(h, s);

    // manager is enough for setStatus...
    await asUser(h, a.agencyOwner).mutation(api.quoteRequests.setStatus, {
      clientSlug: "alpha", requestId: s.alphaRequest, status: "contacted",
    });

    // ...but publishing the client's site is owner-tier and must refuse.
    await expect(
      asUser(h, a.agencyOwner).mutation(api.siteConfigs.publish, {
        clientSlug: "alpha", siteId: s.alphaSite,
      }),
    ).rejects.toThrow(/role:owner/);
  });
});

describe("impersonation", () => {
  const seedOperator = async (
    h: Harness,
    clientId: Id<"clients">,
    session?: { mode: "read" | "act"; expiresAt: number },
  ) =>
    h.run(async (ctx) => {
      const operator = await ctx.db.insert("users", {
        email: `op-${Math.floor(Math.random() * 1e9)}@thecreativecurrent.co.za`,
      });
      await ctx.db.insert("platformMembers", {
        userId: operator, role: "operator", active: true,
      });
      let sessionId: Id<"impersonationSessions"> | undefined;
      if (session) {
        sessionId = await ctx.db.insert("impersonationSessions", {
          platformUserId: operator, clientId, mode: session.mode,
          reason: "support", startedAt: Date.now(), expiresAt: session.expiresAt,
        });
      }
      return { operator, sessionId };
    });

  test("a platform user with no session reaches nothing", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);
    const { operator } = await seedOperator(h, s.alphaId);

    await expect(
      asUser(h, operator).query(api.quoteRequests.list, { clientSlug: "alpha" }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("read-mode impersonation can read but not write", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);
    const { operator } = await seedOperator(h, s.alphaId, {
      mode: "read", expiresAt: Date.now() + 60 * 60_000,
    });

    await expect(
      asUser(h, operator).query(api.quoteRequests.list, { clientSlug: "alpha" }),
    ).resolves.toHaveLength(1);

    await expect(
      asUser(h, operator).mutation(api.quoteRequests.setStatus, {
        clientSlug: "alpha", requestId: s.alphaRequest, status: "lost",
      }),
    ).rejects.toThrow(/acting mode/);
  });

  test("an expired session stops working", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);
    const { operator } = await seedOperator(h, s.alphaId, {
      mode: "act", expiresAt: Date.now() - 60_000,
    });

    await expect(
      asUser(h, operator).query(api.quoteRequests.list, { clientSlug: "alpha" }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  test("acting-mode writes are audit-logged against the session", async () => {
    const h = harness();
    const s = await seedTwoTenants(h);
    const { operator, sessionId } = await seedOperator(h, s.alphaId, {
      mode: "act", expiresAt: Date.now() + 60 * 60_000,
    });

    await asUser(h, operator).mutation(api.quoteRequests.setStatus, {
      clientSlug: "alpha", requestId: s.alphaRequest, status: "contacted",
    });

    const entries = await h.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_client_at", (q) => q.eq("clientId", s.alphaId))
        .collect(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.impersonationSessionId).toBe(sessionId);
    expect(entries[0]!.action).toBe("quoteRequest.setStatus");
  });
});
