import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { dispatchToClient, PLATFORM_QUIET_TIMEZONE } from "./lib/messaging";
import type { Id } from "./_generated/dataModel";

/**
 * MESSAGES FROM US TO A CLIENT.
 *
 * The other pipeline sends to a client's CUSTOMER and is tested in
 * messaging.test.ts. This one exists because almost none of those rules
 * survive the change of recipient, and the differences are the whole point:
 *
 *   - quiet hours are the client's setting about THEIR customers, so they are
 *     not consulted here at all
 *   - the freshness window IS, because a backlog draining at 03:00 is the
 *     same failure whoever is on the other end
 *   - the From line, the reply-to and the copy all point the other way round
 *
 * guards.test.ts holds the structural half — that the client path cannot read
 * a timezone and that no client-directed kind can join the customer exemption
 * list. This file holds the behaviour.
 */

const modules = import.meta.glob("./**/*.ts");
const harness = () => convexTest(schema, modules);

/** 21:00 in Johannesburg — inside quiet hours by any reading. */
const NIGHT = Date.UTC(2026, 8, 2, 19);
/** 10:00 in Johannesburg. */
const MORNING = Date.UTC(2026, 8, 2, 8);

afterEach(() => {
  vi.unstubAllEnvs();
});

async function aClient(
  h: ReturnType<typeof harness>,
  overrides: Record<string, unknown> = {},
): Promise<Id<"clients">> {
  return h.run(async (ctx) => {
    const ventureId = await ctx.db.insert("ventures", {
      name: "Sites",
      type: "platform",
      currency: "ZAR",
      active: true,
      sortOrder: 1,
    });
    return ctx.db.insert("clients", {
      ventureId,
      kind: "platform",
      name: "Renu Solar",
      slug: "renu-solar",
      status: "live",
      timezone: "Africa/Johannesburg",
      currency: "ZAR",
      primaryContactEmail: "owner@renusolar.co.za",
      featureFlags: {},
      isDemo: false,
      isSeed: false,
      ...overrides,
    });
  });
}

const invite = (inviteId: string) =>
  ({ kind: "client.invite", inviteId: inviteId as Id<"invites"> }) as const;

async function send(
  h: ReturnType<typeof harness>,
  clientId: Id<"clients">,
  args: { triggeredAt: number; now: number; inviteId?: string },
) {
  return h.run((ctx) =>
    dispatchToClient(ctx, {
      message: invite(args.inviteId ?? "inv1"),
      clientId,
      templateKey: "client_invite",
      payload: { signInUrl: "https://example.test/c/renu-solar/sign-in", email: "a@b.test" },
      triggeredAt: args.triggeredAt,
      now: args.now,
    }),
  );
}

describe("quiet hours are not in scope, and the client's own setting is never read", () => {
  test("A FRESH MESSAGE GOES OUT AT 21:00", async () => {
    /*
     * The whole reason this is a separate function. On the customer path a
     * 21:00 message is held unless its type is on a short exemption list.
     * Here there is no list to be on: an invoice or an invite is not covered
     * by a setting about somebody else's customers.
     */
    const h = harness();
    const clientId = await aClient(h);

    const result = await send(h, clientId, { triggeredAt: NIGHT, now: NIGHT });

    expect(result.outcome).toBe("queued");
    if (result.outcome !== "queued") return;
    expect(result.held).toBe(false);
    expect(result.scheduledFor).toBe(NIGHT);
  });

  test("AND A CLIENT WITH AGGRESSIVE QUIET HOURS CHANGES NOTHING", async () => {
    /*
     * The negative control for the rule, expressed as behaviour rather than
     * as a source scan: a client in a timezone where it is the middle of the
     * night still receives, because their timezone is not consulted.
     */
    const h = harness();
    const clientId = await aClient(h, { timezone: "Pacific/Auckland" });

    const result = await send(h, clientId, { triggeredAt: NIGHT, now: NIGHT });

    expect(result.outcome).toBe("queued");
    if (result.outcome !== "queued") return;
    expect(result.held).toBe(false);
  });

  test("the row records OUR timezone, because that is the window it was judged in", async () => {
    const h = harness();
    const clientId = await aClient(h, { timezone: "Pacific/Auckland" });
    await send(h, clientId, { triggeredAt: MORNING, now: MORNING });

    const row = await h.run((ctx) => ctx.db.query("messages").first());
    expect(row!.quietHoursTimezone).toBe(PLATFORM_QUIET_TIMEZONE);
  });
});

describe("the freshness window survives, because the 03:00 backlog does not care who you are", () => {
  test("A STALE MESSAGE AT 03:00 WAITS FOR MORNING", async () => {
    /*
     * The case the window exists for. An invoice queued at 16:00 and stuck
     * behind a dead drain until 03:00 must not arrive at 03:00 — and the
     * decision is re-made from the deadline on the row, not from a flag, so
     * the drain reaches the same answer hours later.
     */
    const h = harness();
    const clientId = await aClient(h);

    const issuedAt = Date.UTC(2026, 8, 2, 14); // 16:00 SAST
    const drainedAt = Date.UTC(2026, 8, 3, 1); // 03:00 SAST, eleven hours later

    const result = await send(h, clientId, { triggeredAt: issuedAt, now: drainedAt });

    expect(result.outcome).toBe("queued");
    if (result.outcome !== "queued") return;
    expect(result.held).toBe(true);
    expect(result.scheduledFor).toBeGreaterThan(drainedAt);

    // 08:00 SAST is 06:00 UTC. Landing in the morning, not at dawn.
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: PLATFORM_QUIET_TIMEZONE,
      hour: "numeric",
      hour12: false,
    }).format(new Date(result.scheduledFor));
    expect(Number(hour)).toBeGreaterThanOrEqual(8);
  });

  test("and the row carries the DEADLINE, so the drain can re-decide", async () => {
    const h = harness();
    const clientId = await aClient(h);
    await send(h, clientId, { triggeredAt: NIGHT, now: NIGHT });

    const row = await h.run((ctx) => ctx.db.query("messages").first());
    expect(row!.quietHoursExemptUntil).toBe(NIGHT + 60 * 60 * 1000);
  });

  test("exactly one hour: 59 minutes late still goes, 61 waits", async () => {
    const h = harness();
    const clientId = await aClient(h);

    const justInside = await send(h, clientId, {
      triggeredAt: NIGHT,
      now: NIGHT + 59 * 60 * 1000,
      inviteId: "a",
    });
    const justOutside = await send(h, clientId, {
      triggeredAt: NIGHT,
      now: NIGHT + 61 * 60 * 1000,
      inviteId: "b",
    });

    expect(justInside.outcome === "queued" && justInside.held).toBe(false);
    expect(justOutside.outcome === "queued" && justOutside.held).toBe(true);
  });
});

describe("the population gate, which replaces consent and the suppression list", () => {
  test("a SEED client is refused, and the row says so", async () => {
    const h = harness();
    const clientId = await aClient(h, { isSeed: true });

    const result = await send(h, clientId, { triggeredAt: MORNING, now: MORNING });

    expect(result.outcome).toBe("suppressed_demo");
    const row = await h.run((ctx) => ctx.db.query("messages").first());
    expect(row!.status).toBe("suppressed_demo");
  });

  test("NO CONTACT EMAIL IS A VISIBLE REFUSAL, not a silent drop", async () => {
    const h = harness();
    const clientId = await aClient(h, { primaryContactEmail: undefined });

    const result = await send(h, clientId, { triggeredAt: MORNING, now: MORNING });

    expect(result.outcome).toBe("no_destination");
    const row = await h.run((ctx) => ctx.db.query("messages").first());
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("Renu Solar");
  });

  test("the same message is never queued twice", async () => {
    const h = harness();
    const clientId = await aClient(h);

    await send(h, clientId, { triggeredAt: MORNING, now: MORNING });
    const again = await send(h, clientId, { triggeredAt: MORNING, now: MORNING });

    expect(again.outcome).toBe("duplicate");
    const rows = await h.run((ctx) => ctx.db.query("messages").collect());
    expect(rows).toHaveLength(1);
  });
});

describe("a lead who became this client is not a prospect any more", () => {
  /**
   * The bug this exists to prevent is total rather than occasional: a
   * converted lead keeps its row, so without the exception every invoice and
   * every invite to every client sourced through the call queue — which is
   * all of them — is refused as outreach to a business we are prospecting.
   */
  async function withLead(converted: boolean) {
    const h = harness();
    const clientId = await aClient(h);
    const client = (await h.run((ctx) => ctx.db.get(clientId)))!;

    await h.run((ctx) =>
      ctx.db.insert("leads", {
        ventureId: client.ventureId,
        businessName: "Renu Solar",
        website: "https://renusolar.co.za",
        niche: "solar",
        auditFaults: [],
        status: converted ? "converted" : "new",
        convertedClientId: converted ? clientId : undefined,
        provenance: {
          source: "campaign_list",
          capturedAt: MORNING,
          lawfulBasis: "legitimate_interest",
        },
      }),
    );
    return { h, clientId };
  }

  test("AN UNCONVERTED LEAD ON THAT DOMAIN STILL BLOCKS", async () => {
    const { h, clientId } = await withLead(false);
    const result = await send(h, clientId, { triggeredAt: MORNING, now: MORNING });

    expect(result.outcome).toBe("suppressed_lead");
    const row = await h.run((ctx) => ctx.db.query("messages").first());
    expect(row!.status).toBe("suppressed_lead");
    // Named, so whoever reads the outbox can tell a mistake from a coincidence.
    expect(row!.error).toContain("Renu Solar");
  });

  test("ONCE CONVERTED INTO THIS CLIENT, IT SENDS", async () => {
    const { h, clientId } = await withLead(true);
    const result = await send(h, clientId, { triggeredAt: MORNING, now: MORNING });

    expect(result.outcome).toBe("queued");
  });

  test("but a DIFFERENT client's conversion does not excuse it", async () => {
    /*
     * The exception is narrow on purpose: it excuses the one business this
     * message is for and nobody else, so a contact email typed onto the wrong
     * client is still caught.
     */
    const { h, clientId } = await withLead(false);
    const otherClientId = await h.run(async (ctx) => {
      const client = (await ctx.db.get(clientId))!;
      return ctx.db.insert("clients", {
        ventureId: client.ventureId,
        kind: "platform",
        name: "Somebody Else",
        slug: "somebody-else",
        status: "live",
        timezone: "Africa/Johannesburg",
        currency: "ZAR",
        featureFlags: {},
        isDemo: false,
        isSeed: false,
      });
    });
    // The lead converted into a DIFFERENT client than the one we are writing to.
    await h.run(async (ctx) => {
      const lead = (await ctx.db.query("leads").first())!;
      await ctx.db.patch(lead._id, { convertedClientId: otherClientId });
    });

    const result = await send(h, clientId, { triggeredAt: MORNING, now: MORNING });
    expect(result.outcome).toBe("suppressed_lead");
  });
});

describe("end to end: issuing an invoice writes the document AND the email", () => {
  async function issued() {
    const h = harness();
    const { userId } = await h.mutation(internal.bootstrap.claimPlatformOwner, {
      email: "owner@thecreativecurrent.co.za",
    });
    const owner = h.withIdentity({ subject: `${userId}|test-session` });
    const clientId = await aClient(h);
    const client = (await h.run((ctx) => ctx.db.get(clientId)))!;

    await h.run((ctx) =>
      ctx.db.insert("issuers", {
        ventureId: client.ventureId,
        legalName: "Taine Bird",
        addressLine: "1 Sample Road",
        city: "Durban",
        countryCode: "ZA",
        email: "accounts@thecreativecurrent.co.za",
        bankName: "FNB",
        bankAccountName: "Taine Bird",
        bankAccountNumber: "62000000000",
        bankBranchCode: "250655",
        updatedAt: MORNING,
        confirmedAt: MORNING,
        confirmedBy: userId,
      }),
    );

    const result = await owner.mutation(api.invoices.issue, {
      clientId,
      lineItems: [{ description: "Website build", quantity: 1, unitPriceCents: 950000 }],
      now: MORNING,
    });
    return { h, owner, clientId, result };
  }

  test("THE EMAIL IS QUEUED IN THE SAME TRANSACTION", async () => {
    /*
     * An invoice that committed while its delivery did not is the failure
     * worth preventing: the admin screen shows a document that went out and
     * the client never received one.
     */
    const { h, result } = await issued();
    expect(result.delivery).toBe("queued");

    const row = await h.run((ctx) => ctx.db.query("messages").first());
    expect(row!.templateKey).toBe("invoice_issued");
    expect(row!.to).toBe("owner@renusolar.co.za");
    // Client-directed, which is what flips the From line and the reply-to.
    expect(row!.customerId).toBeUndefined();
  });

  test("AND THE LINK OPENS THAT INVOICE AND NOTHING ELSE", async () => {
    const { h, result } = await issued();
    const token = result.viewUrl.split("/i/")[1]!;

    const doc = await h.query(api.public.invoice.view, { token });

    expect(doc.number).toBe(result.number);
    expect(doc.paymentReference).toBe(result.number);
    expect(doc.billToName).toBe("Renu Solar");
    expect(doc.settlement).toBe("unpaid");
    // Where to pay is read live; who issued it is a snapshot.
    expect(doc.issuer?.bank?.accountNumber).toBe("62000000000");
    expect(doc.issuerLegalName).toBe("Taine Bird");
    // Nothing that could be substituted into another query.
    expect(doc).not.toHaveProperty("clientId");
    expect(doc).not.toHaveProperty("ventureId");
  });

  test("A WRONG TOKEN IS INDISTINGUISHABLE FROM A MISSING ONE", async () => {
    const { h } = await issued();
    await expect(
      h.query(api.public.invoice.view, { token: "f".repeat(64) }),
    ).rejects.toThrow(/not valid/);
  });

  test("REVOKING KILLS THE LINK AND LEAVES THE INVOICE ALONE", async () => {
    const { h, owner, result } = await issued();
    const token = result.viewUrl.split("/i/")[1]!;
    const invoiceId = await h.run(async (ctx) => (await ctx.db.query("invoices").first())!._id);

    await owner.mutation(api.invoices.revokeViewLink, { invoiceId, now: MORNING });

    await expect(h.query(api.public.invoice.view, { token })).rejects.toThrow(/withdrawn/);
    // The document is untouched: revoking a link is not voiding an invoice.
    const invoice = await h.run((ctx) => ctx.db.get(invoiceId));
    expect(invoice!.status).toBe("issued");
  });

  test("and a reissued link works while the old one does not", async () => {
    const { h, owner, result } = await issued();
    const oldToken = result.viewUrl.split("/i/")[1]!;
    const invoiceId = await h.run(async (ctx) => (await ctx.db.query("invoices").first())!._id);

    const fresh = await owner.mutation(api.invoices.reissueViewLink, { invoiceId, now: MORNING });
    const newToken = fresh.viewUrl.split("/i/")[1]!;

    expect(newToken).not.toBe(oldToken);
    await expect(h.query(api.public.invoice.view, { token: oldToken })).rejects.toThrow();
    expect((await h.query(api.public.invoice.view, { token: newToken })).number).toBe(result.number);
  });

  test("NO LINK ORIGIN, NO INVOICE — and no number is burned", async () => {
    /*
     * The opposite answer to the one messaging gives elsewhere, on purpose.
     * An unreachable customer is a fact about the world and a booking is
     * still taken; an unset SITE_URL is a fact about the deployment, and
     * issuing past it burns a number on a document nobody can open.
     */
    const { h, owner, clientId } = await issued();
    vi.stubEnv("SITE_URL", "");

    await expect(
      owner.mutation(api.invoices.issue, {
        clientId,
        lineItems: [{ description: "Second", quantity: 1, unitPriceCents: 1000 }],
        now: MORNING,
      }),
    ).rejects.toThrow(/SITE_URL/);

    // One invoice, and the counter did not advance past it.
    const invoices = await h.run((ctx) => ctx.db.query("invoices").collect());
    expect(invoices).toHaveLength(1);
    const counter = await h.run((ctx) => ctx.db.query("invoiceCounters").first());
    expect(counter!.next).toBe(2);
  });
});
