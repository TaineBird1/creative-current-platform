import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import {
  normaliseHostname,
  hostnameShape,
  requiredRecords,
  dnsOnePager,
  VERCEL_APEX_A,
  VERCEL_CNAME,
} from "./lib/dns";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const asUser = (h: Harness, userId: Id<"users">) =>
  h.withIdentity({ subject: `${userId}|test-session` });

describe("hostname parsing", () => {
  test("strips what people actually paste", () => {
    expect(normaliseHostname("  HTTPS://Renusolar.co.za/contact  ")).toBe("renusolar.co.za");
    expect(normaliseHostname("renusolar.co.za.")).toBe("renusolar.co.za");
  });

  test("rejects things that are not hostnames", () => {
    for (const bad of ["", "renusolar", "not a domain.com", "-bad.co.za", "co.za "]) {
      expect(() => normaliseHostname(bad), bad).toThrow();
    }
  });
});

describe("apex versus subdomain", () => {
  // Getting this wrong is the most common reason a domain never goes live:
  // a CNAME at a zone root is refused by the registrar.
  test.each([
    ["renusolar.co.za", "apex"],
    ["renusolar.com", "apex"],
    ["www.renusolar.co.za", "subdomain"],
    ["book.renusolar.com", "subdomain"],
    ["shop.co.uk", "apex"],
    ["www.shop.co.uk", "subdomain"],
  ])("%s is %s", (hostname, kind) => {
    expect(hostnameShape(hostname).kind).toBe(kind);
  });

  test("a .co.za apex is not mistaken for a subdomain", () => {
    // Label-counting would call this a subdomain and hand the client a CNAME
    // their registrar will refuse. South African clients are the default here.
    const shape = hostnameShape("renusolar.co.za");
    expect(shape.kind).toBe("apex");

    const records = requiredRecords("renusolar.co.za");
    expect(records[0]!.type).toBe("A");
    expect(records[0]!.value).toBe(VERCEL_APEX_A);
  });

  test("an apex also gets www, so both spellings work", () => {
    const records = requiredRecords("renusolar.co.za");
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ type: "CNAME", name: "www", value: VERCEL_CNAME });
  });

  test("a subdomain gets exactly one CNAME on its own label", () => {
    const records = requiredRecords("book.renusolar.co.za");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "CNAME", name: "book", value: VERCEL_CNAME });
  });
});

describe("the one-pager", () => {
  const sheet = dnsOnePager({
    hostname: "renusolar.co.za",
    businessName: "Renu Solar",
    records: requiredRecords("renusolar.co.za"),
  });

  test("names the business and the domain", () => {
    expect(sheet).toContain("renusolar.co.za");
    expect(sheet).toContain("Renu Solar");
  });

  test("uses the registrar's vocabulary, not ours", () => {
    expect(sheet).toContain("Host / Name");
    expect(sheet).toContain("Points to");
    expect(sheet).toContain("TTL");
  });

  test("carries the two warnings that cause real support tickets", () => {
    expect(sheet).toContain("REPLACE");   // duplicate records at the same host
    expect(sheet.toLowerCase()).toContain("email"); // "will this break my email?"
  });

  test("explains the @ host, which registrars all spell differently", () => {
    expect(sheet).toContain("@");
  });

  test("is plain text, because it gets pasted into WhatsApp", () => {
    expect(sheet).not.toMatch(/[<>*_`|]/);
  });
});

/* ------------------------------------------------------------------ */

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

    const mkSite = (clientId: Id<"clients">, slug: string) =>
      ctx.db.insert("sites", {
        clientId, slug, status: "live", config: {},
        version: 1, configSchemaVersion: 1, isDemo: false,
      });
    await mkSite(alphaId, "alpha");
    await mkSite(bravoId, "bravo");

    const operator = await ctx.db.insert("users", { email: "op@thecreativecurrent.co.za" });
    await ctx.db.insert("platformMembers", { userId: operator, role: "owner", active: true });

    const tenantUser = await ctx.db.insert("users", { email: "owner@alpha.test" });
    await ctx.db.insert("memberships", {
      userId: tenantUser, clientId: alphaId, role: "owner", active: true, acceptedAt: Date.now(),
    });

    return { alphaId, bravoId, operator, tenantUser };
  });
}

describe("claiming a hostname", () => {
  test("an operator can claim one, and it becomes primary", async () => {
    const h = harness();
    const s = await seed(h);

    const { created } = await asUser(h, s.operator).mutation(api.domains.claim, {
      clientId: s.alphaId, hostname: "Renusolar.co.za",
    });
    expect(created).toBe(true);

    const domain = await h.run((ctx) =>
      ctx.db.query("domains").withIndex("by_hostname", (q) => q.eq("hostname", "renusolar.co.za")).unique(),
    );
    expect(domain?.clientId).toBe(s.alphaId);
    expect(domain?.isPrimary).toBe(true);
    expect(domain?.verificationStatus).toBe("pending");
  });

  test("A HOSTNAME CANNOT BE TAKEN FROM ANOTHER CLIENT", async () => {
    // by_hostname is the first hop of tenant resolution on the public app.
    // A second claim is an attempt to serve someone else's traffic, whether
    // malicious or an operator's honest mistake.
    const h = harness();
    const s = await seed(h);
    const op = asUser(h, s.operator);

    await op.mutation(api.domains.claim, { clientId: s.alphaId, hostname: "renusolar.co.za" });

    await expect(
      op.mutation(api.domains.claim, { clientId: s.bravoId, hostname: "renusolar.co.za" }),
    ).rejects.toThrow(/already attached to another client/);

    const domain = await h.run((ctx) =>
      ctx.db.query("domains").withIndex("by_hostname", (q) => q.eq("hostname", "renusolar.co.za")).unique(),
    );
    expect(domain?.clientId).toBe(s.alphaId);
  });

  test("case and formatting cannot be used to claim it twice", async () => {
    const h = harness();
    const s = await seed(h);
    const op = asUser(h, s.operator);

    await op.mutation(api.domains.claim, { clientId: s.alphaId, hostname: "renusolar.co.za" });

    await expect(
      op.mutation(api.domains.claim, { clientId: s.bravoId, hostname: "https://RENUSOLAR.co.za/" }),
    ).rejects.toThrow(/already attached to another client/);
  });

  test("re-claiming for the SAME client is a no-op, so the wizard is re-runnable", async () => {
    const h = harness();
    const s = await seed(h);
    const op = asUser(h, s.operator);

    const first = await op.mutation(api.domains.claim, {
      clientId: s.alphaId, hostname: "renusolar.co.za",
    });
    const second = await op.mutation(api.domains.claim, {
      clientId: s.alphaId, hostname: "renusolar.co.za",
    });

    expect(second.created).toBe(false);
    expect(second.domainId).toBe(first.domainId);
  });

  test("a client with no site cannot have a domain", async () => {
    const h = harness();
    const s = await seed(h);
    const siteless = await h.run(async (ctx) => {
      const venture = await ctx.db.query("ventures").first();
      return ctx.db.insert("clients", {
        ventureId: venture!._id, kind: "platform", name: "Siteless", slug: "siteless",
        status: "onboarding", timezone: "Africa/Johannesburg", currency: "ZAR",
        featureFlags: {}, isDemo: false, isSeed: false,
      });
    });

    await expect(
      asUser(h, s.operator).mutation(api.domains.claim, {
        clientId: siteless, hostname: "siteless.co.za",
      }),
    ).rejects.toThrow(/no site yet/);
  });

  test("an invalid hostname never reaches the database", async () => {
    const h = harness();
    const s = await seed(h);

    await expect(
      asUser(h, s.operator).mutation(api.domains.claim, {
        clientId: s.alphaId, hostname: "not a domain",
      }),
    ).rejects.toThrow();

    const all = await h.run((ctx) => ctx.db.query("domains").collect());
    expect(all).toHaveLength(0);
  });

  test("a claim is audit-logged", async () => {
    const h = harness();
    const s = await seed(h);
    await asUser(h, s.operator).mutation(api.domains.claim, {
      clientId: s.alphaId, hostname: "renusolar.co.za",
    });

    const entries = await h.run((ctx) =>
      ctx.db.query("auditLog").withIndex("by_client_at", (q) => q.eq("clientId", s.alphaId)).collect(),
    );
    expect(entries[0]?.action).toBe("domain.claim");
  });
});

describe("who may run the wizard", () => {
  test("a client owner cannot claim a domain", async () => {
    // Platform-side only: a client who could claim an arbitrary hostname
    // could claim somebody else's.
    const h = harness();
    const s = await seed(h);

    await expect(
      asUser(h, s.tenantUser).mutation(api.domains.claim, {
        clientId: s.alphaId, hostname: "renusolar.co.za",
      }),
    ).rejects.toThrow(/platform access/);
  });

  test("a client owner cannot read the wizard's view", async () => {
    const h = harness();
    const s = await seed(h);

    await expect(
      asUser(h, s.tenantUser).query(api.domains.forClient, { clientId: s.alphaId }),
    ).rejects.toThrow(/platform access/);
  });

  test("an unauthenticated caller cannot", async () => {
    const h = harness();
    const s = await seed(h);

    await expect(
      h.mutation(api.domains.claim, { clientId: s.alphaId, hostname: "renusolar.co.za" }),
    ).rejects.toThrow(/UNAUTHENTICATED/);
  });
});

describe("the Vercel-facing actions are guarded too", () => {
  // Actions have no ctx.db, so they cannot run requirePlatform directly. The
  // first version shipped them as bare `action()` — public, unauthenticated
  // endpoints that would attach domains to our Vercel project on request.
  // guards.test.ts caught it; these pin the behaviour.
  test("attach refuses an unauthenticated caller", async () => {
    const h = harness();
    const s = await seed(h);
    const domainId = await asUser(h, s.operator)
      .mutation(api.domains.claim, { clientId: s.alphaId, hostname: "renusolar.co.za" })
      .then((r) => r.domainId);

    await expect(h.action(api.domains.attach, { domainId })).rejects.toThrow(
      /UNAUTHENTICATED/,
    );
  });

  test("attach refuses a client owner", async () => {
    const h = harness();
    const s = await seed(h);
    const domainId = await asUser(h, s.operator)
      .mutation(api.domains.claim, { clientId: s.alphaId, hostname: "renusolar.co.za" })
      .then((r) => r.domainId);

    await expect(
      asUser(h, s.tenantUser).action(api.domains.attach, { domainId }),
    ).rejects.toThrow(/platform access/);
  });

  test("refresh refuses a client owner", async () => {
    const h = harness();
    const s = await seed(h);
    const domainId = await asUser(h, s.operator)
      .mutation(api.domains.claim, { clientId: s.alphaId, hostname: "renusolar.co.za" })
      .then((r) => r.domainId);

    await expect(
      asUser(h, s.tenantUser).action(api.domains.refresh, { domainId }),
    ).rejects.toThrow(/platform access/);
  });
});

describe("without a Vercel token", () => {
  test("the wizard still produces real, actionable instructions", async () => {
    // Onboarding must not block on an account setup that has nothing to do
    // with the client.
    const h = harness();
    const s = await seed(h);
    const op = asUser(h, s.operator);

    await op.mutation(api.domains.claim, { clientId: s.alphaId, hostname: "renusolar.co.za" });
    const view = await op.query(api.domains.forClient, { clientId: s.alphaId });

    expect(view.vercelConfigured).toBe(false);
    expect(view.domains[0]!.records[0]!.value).toBe(VERCEL_APEX_A);
    expect(view.domains[0]!.onePager).toContain("renusolar.co.za");
  });
});
