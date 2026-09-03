import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ownerMutation } from "./lib/functions";
import { promoteSiteToLive } from "./siteConfigs";
import { mintClientOwnerInvite } from "./invites";
import { dispatchToClient } from "./lib/messaging";
import { clientSignInUrl } from "./lib/links";
import { issueInvoiceFor } from "./invoices";
import type { Id } from "./_generated/dataModel";
import { createBooking } from "./bookings";
import { toE164, toStorageKey } from "./lib/phone";
import { patchDoc } from "./lib/db";

/**
 * THE FIRST REAL CLIENT, BY HAND.
 *
 * WHAT THIS IS NOT: the onboarding transaction. That one starts from a won
 * deal and produces a client, a site, a membership, an owner invite, a
 * checklist and a build invoice, atomically, and it is not built. Nothing here
 * writes `sites`, sends an invite, or touches a deal. If you came looking for
 * onboarding, it is still owed.
 *
 * WHAT THIS IS: the smallest honest way to get one real client into a
 * deployment so the messaging pipeline can be exercised against a real
 * mailbox. The alternative on offer was flipping `isSeed` to false on the
 * seeded demo client, which is turning off a guard to pass a test — and a
 * guard turned off for a test is a guard that stays off, because nothing ever
 * reminds anyone to put it back. A real client is also simply the truer test:
 * seeded data is refused by `dispatch` precisely so that it can never be the
 * thing you verified against.
 *
 * IT DISARMS ITSELF, the same way `bootstrap:claimPlatformOwner` does and for
 * the same reason. Once one real client exists this refuses, so it cannot
 * become the way clients get made — that is the onboarding transaction's job,
 * and a convenient back door is how it stays unbuilt.
 *
 *   npx convex run onboarding:createFirstClient '{"name":"...","slug":"...",
 *     "ownerEmail":"you@example.com","contactEmail":"you@example.com"}'
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

const required = (value: string, what: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw bad("INVALID", `${what} cannot be blank.`);
  return trimmed;
};

export const createFirstClient = internalMutation({
  args: {
    name: v.string(),
    /** Drives app.<domain>/c/<slug>. Lower case, hyphenated. */
    slug: v.string(),
    /**
     * An EXISTING account. Not created here, for the same reason
     * `claimPlatformOwner` does not create one: an account minted by a setup
     * script is an account nobody chose the address of.
     */
    ownerEmail: v.string(),
    /**
     * Where a customer's reply goes. Without it every message this client
     * sends falls back to the deployment-wide MESSAGING_REPLY_TO, which is
     * OUR mailbox, not theirs.
     */
    contactEmail: v.string(),
    contactName: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    locationName: v.optional(v.string()),
    city: v.optional(v.string()),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = required(args.name, "The client's name");
    const slug = required(args.slug, "The slug").toLowerCase();
    const ownerEmail = required(args.ownerEmail, "The owner's email").toLowerCase();
    const contactEmail = required(args.contactEmail, "The contact email");

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
      throw bad("INVALID", "A slug is lower-case letters, numbers and hyphens.");
    }

    /*
     * THE DISARM. A real client is one that is neither demo nor seed — which
     * is exactly the population `dispatch` will actually message, so it is the
     * right thing to count.
     */
    const real = (await ctx.db.query("clients").collect()).find((c) => !c.isDemo && !c.isSeed);
    if (real) {
      throw bad(
        "ALREADY_ONBOARDED",
        `"${real.name}" already exists, so this is not the first client any more. ` +
          "Onboarding a second one is the onboarding transaction's job, and it is not " +
          "built — build it rather than widening this.",
      );
    }

    const taken = await ctx.db
      .query("clients")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (taken) throw bad("SLUG_TAKEN", `The slug "${slug}" is already in use.`);

    const owner = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", ownerEmail))
      .first();
    if (!owner) {
      throw bad(
        "NO_SUCH_USER",
        `No account for ${ownerEmail}. Sign in once first — this grants access to an ` +
          "existing account and will not create one.",
      );
    }

    const venture =
      (await ctx.db
        .query("ventures")
        .filter((q) => q.eq(q.field("type"), "platform"))
        .first()) ??
      (await ctx.db.get(
        await ctx.db.insert("ventures", {
          name: "Sites",
          type: "platform",
          currency: "ZAR",
          active: true,
          sortOrder: 1,
        }),
      ))!;

    const timezone = args.timezone ?? "Africa/Johannesburg";

    const clientId = await ctx.db.insert("clients", {
      ventureId: venture._id,
      kind: "platform",
      name,
      slug,
      status: "live",
      timezone,
      currency: venture.currency,
      primaryContactName: args.contactName?.trim() || undefined,
      primaryContactEmail: contactEmail,
      primaryContactPhone: args.contactPhone?.trim() || undefined,
      featureFlags: { quotes: true },
      // The whole point. Neither flag, so `dispatch` will actually send.
      isDemo: false,
      isSeed: false,
      goLiveAt: Date.now(),
    });

    const locationId = await ctx.db.insert("locations", {
      clientId,
      name: args.locationName?.trim() || name,
      addressLine: "",
      suburb: "",
      city: args.city?.trim() || "Durban",
      region: "KwaZulu-Natal",
      countryCode: "ZA",
      timezone,
      phone: args.contactPhone?.trim() || undefined,
      active: true,
    });

    const serviceId = await ctx.db.insert("services", {
      clientId,
      key: "assessment",
      name: "Site assessment",
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceCents: 0,
      currency: venture.currency,
      quoteRequired: false,
      sortOrder: 1,
      active: true,
    });

    await ctx.db.insert("memberships", {
      userId: owner._id,
      clientId,
      role: "owner",
      active: true,
      acceptedAt: Date.now(),
    });

    /*
     * Written here rather than through `auditWrite`, which needs a tenant
     * context this call does not have. Same precedent as bootstrap.ts: the
     * act still gets a row, attributed to the account it was granted to.
     */
    await ctx.db.insert("auditLog", {
      actorUserId: owner._id,
      clientId,
      ventureId: venture._id,
      at: Date.now(),
      action: "onboarding.createFirstClient",
      entityTable: "clients",
      entityId: clientId,
      after: { name, slug, contactEmail },
    });

    return {
      clientId,
      locationId,
      serviceId,
      slug,
      backOffice: `/c/${slug}`,
      note:
        "No site config was written — this client has a back office and no public " +
        "website. siteConfigs is the only writer of that table.",
    };
  },
});

/**
 * A booking against that client, taken the way the back office would take one.
 *
 * There is no booking screen yet, so without this the messaging pipeline has
 * no reachable entry point outside the test suite — and a pipeline verified
 * only by its own tests is one nobody has watched work.
 *
 * It goes through `createBooking`, which is the same function `bookings.book`
 * calls: the overlap check, the 24-hour cap, the consent established on the
 * booking, and the confirmation queued in this same transaction. Nothing is
 * reimplemented here, so what this exercises is what a real booking does.
 */
export const takeFirstBooking = internalMutation({
  args: {
    clientSlug: v.string(),
    customerName: v.string(),
    customerPhone: v.string(),
    /** The address the confirmation goes to. Email is the only live channel. */
    customerEmail: v.string(),
    /** Epoch ms. Defaults to this time tomorrow. */
    startsAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const slug = required(args.clientSlug, "The slug").toLowerCase();
    const client = await ctx.db
      .query("clients")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!client) throw bad("NOT_FOUND", `No client with the slug "${slug}".`);

    const location = await ctx.db
      .query("locations")
      .withIndex("by_client", (q) => q.eq("clientId", client._id).eq("active", true))
      .first();
    const service = await ctx.db
      .query("services")
      .withIndex("by_client", (q) => q.eq("clientId", client._id))
      .first();
    if (!location || !service) {
      throw bad("NOT_READY", "That client has no active location or no service.");
    }

    /*
     * The one normaliser. A phone stored raw here would be a second opinion
     * about the suppression key — see lib/phone.ts on the three that once
     * disagreed.
     */
    const normalised = toE164(args.customerPhone);
    const phone = normalised.ok ? normalised.e164 : toStorageKey(args.customerPhone);

    const existing = await ctx.db
      .query("customers")
      .withIndex("by_client_phone", (q) => q.eq("clientId", client._id).eq("phone", phone))
      .first();

    const customerId: Id<"customers"> =
      existing?._id ??
      (await ctx.db.insert("customers", {
        clientId: client._id,
        name: required(args.customerName, "The customer's name"),
        phone,
        email: required(args.customerEmail, "The customer's email"),
        addresses: [],
        tags: [],
        noShowCount: 0,
        lifetimeValueCents: 0,
        currency: client.currency,
        visitCount: 0,
        isDemo: client.isDemo,
        isSeed: client.isSeed,
      }));

    // An existing record may predate the email; the confirmation needs one.
    if (existing && !existing.email) {
      await patchDoc(ctx, existing._id, { email: required(args.customerEmail, "The email") });
    }

    const startsAt = args.startsAt ?? Date.now() + 24 * 60 * 60 * 1000;

    const result = await createBooking(ctx, {
      clientId: client._id,
      locationId: location._id,
      serviceId: service._id,
      customerId,
      startsAt,
      source: "back_office",
    });

    return {
      ...result,
      customerId,
      next:
        result.confirmation.queued
          ? "Queued. `npx convex run outbox:drain '{}'` rather than waiting for the cron."
          : "Nothing was queued — read the notice, it says why.",
    };
  },
});

/* ==========================================================================
 * THE ONBOARDING TRANSACTION
 * ======================================================================= */

/**
 * WON MEANS THEY SAID YES. CONVERTED MEANS THEY EXIST.
 *
 * `deals.advance` deliberately stops at the first: it records the outcome and
 * returns `conversionOwed: true`, because marking a lead converted with no
 * client behind it puts a row in the funnel's last column that every count
 * downstream then gets wrong, in the direction that flatters us. This is the
 * function that pays that debt.
 *
 * ONE TRANSACTION, AND THAT IS THE ENTIRE POINT. Every half of this is useless
 * without the others, and each partial state is its own quiet disaster:
 *
 *   client, no site        — a back office pointing at nothing
 *   site, no membership    — a page nobody who owns it can edit
 *   membership, no invite  — access granted to somebody never told
 *   all of it, no invoice  — a client live and paying nothing, which is the
 *                            one nobody notices for a month
 *   any of it, lead open   — the deal reappears in the pipeline, and somebody
 *                            phones a customer to sell them a website
 *
 * Convex mutations are serializable, so this either all commits or none of it
 * does. That is the whole reason it is one function and not a checklist.
 *
 * THE DEMO IS PROMOTED, NOT REPLACED. See `promoteSiteToLive`.
 */

/**
 * The first-week checklist. Data, not a wiki page, because what actually goes
 * wrong in week one is a client waiting on us while we wait on them — so every
 * row says WHO it is on.
 *
 * Deliberately short. A twenty-item checklist is one nobody opens.
 */
const CHECKLIST: {
  key: string;
  label: string;
  phase: "intake" | "content" | "build" | "review" | "launch";
  owner: "client" | "us";
}[] = [
  { key: "logo", label: "Logo and brand colours", phase: "intake", owner: "client" },
  { key: "photos", label: "Photos of real work", phase: "intake", owner: "client" },
  { key: "services", label: "Services and prices confirmed", phase: "content", owner: "client" },
  { key: "copy", label: "Homepage copy from the demo, corrected", phase: "content", owner: "us" },
  { key: "domain", label: "Domain pointed at the site", phase: "build", owner: "us" },
  { key: "review", label: "Client walks the site and signs off", phase: "review", owner: "client" },
  { key: "handover", label: "Back office walkthrough", phase: "launch", owner: "us" },
];

export const convertWonDeal = ownerMutation({
  args: {
    dealId: v.id("deals"),
    /** The person who will own the back office. An invite is minted for them. */
    ownerEmail: v.string(),
    /**
     * The build fee, in whole cents. Defaults to the deal's own value, which
     * is the price that was actually presented — see deals.ts.
     */
    buildFeeCents: v.optional(v.number()),
    paymentTermsDays: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const ownerEmail = required(args.ownerEmail, "The owner's email").toLowerCase();

    const deal = await ctx.db.get(args.dealId);
    if (!deal) throw bad("NOT_FOUND", "No such deal.");
    if (deal.stage !== "won") {
      throw bad(
        "DEAL_NOT_WON",
        `That deal is at "${deal.stage}". Only a won deal converts — and winning it records ` +
          "what the customer actually said, so do that first rather than around it.",
      );
    }

    const lead = await ctx.db.get(deal.leadId);
    if (!lead) throw bad("NOT_FOUND", "No such lead.");

    /*
     * IDEMPOTENT, and not by accident. A double click, a retried mutation, or
     * somebody converting the same deal twice must not mint a second client, a
     * second invite and a second invoice for one customer. The lead's
     * `convertedClientId` is the record that this already happened, and it is
     * written in this same transaction.
     *
     * Returned rather than thrown: converting twice is an ordinary thing for a
     * person to attempt, not an error they should have to catch.
     */
    if (lead.convertedClientId) {
      return {
        clientId: lead.convertedClientId,
        alreadyConverted: true,
        notice: `${lead.businessName} was already converted. Nothing was changed.`,
      };
    }

    const venture = await ctx.db.get(lead.ventureId);
    if (!venture) throw bad("NOT_FOUND", "No such venture.");

    /*
     * THE ISSUER IS CHECKED BEFORE ANYTHING IS WRITTEN.
     *
     * `issueInvoiceFor` refuses an unconfirmed issuer, and it runs last — so
     * without this the whole transaction would roll back at the final step and
     * report an invoicing problem for what looked like an onboarding action.
     * Checking here turns that into one sentence, before any work.
     *
     * Refusing to onboard over an admin detail is the right way round: it
     * forces the issuer to exist before the first client does, which is the
     * order those two things have to happen in anyway.
     */
    const issuer = await ctx.db
      .query("issuers")
      .withIndex("by_venture", (q) => q.eq("ventureId", lead.ventureId))
      .unique();
    if (!issuer || issuer.confirmedAt === undefined) {
      throw bad(
        "ISSUER_UNCONFIRMED",
        "Confirm the issuer for this venture first. The build invoice carries a legal name " +
          "forever, and a client cannot be onboarded that cannot be billed.",
      );
    }

    /* ----------------------------------------------- the client and the site */

    const demoSite = await ctx.db
      .query("sites")
      .filter((q) => q.eq(q.field("leadId"), deal.leadId))
      .first();

    let clientId: Id<"clients">;
    let siteId: Id<"sites"> | null = null;
    let slug: string;
    let promotedDemo = false;

    if (demoSite) {
      /*
       * The URL they were sold on stays theirs. A second site would take a
       * second slug, because the first one is occupied by the demo.
       */
      const demoClient = await ctx.db.get(demoSite.clientId);
      if (!demoClient) throw bad("NOT_FOUND", "The demo's client is missing.");

      clientId = demoClient._id;
      siteId = demoSite._id;
      slug = demoSite.slug;
      promotedDemo = true;

      await patchDoc(ctx, clientId, {
        status: "live",
        /*
         * The flag every money and messaging path checks. It comes off HERE
         * and only here — they have signed, which is the event it was waiting
         * for. Anywhere else this would be turning off a guard.
         */
        isDemo: false,
        name: lead.businessName,
        primaryContactEmail: ownerEmail,
        primaryContactPhone: lead.phone ?? undefined,
        goLiveAt: now,
      });

      await promoteSiteToLive(ctx, demoSite._id);
    } else {
      /*
       * No demo — a referral, an inbound enquiry. It gets a client and a back
       * office and NO site, because a site needs a template, a brand colour
       * and copy, and inventing those is the demo builder's job rather than
       * this one's. The extra checklist row below says so out loud, rather
       * than leaving somebody to notice.
       */
      slug = await freeSlug(ctx, lead.businessName);
      clientId = await ctx.db.insert("clients", {
        ventureId: lead.ventureId,
        kind: "platform",
        name: lead.businessName,
        slug,
        status: "onboarding",
        timezone: "Africa/Johannesburg",
        currency: venture.currency,
        primaryContactEmail: ownerEmail,
        primaryContactPhone: lead.phone ?? undefined,
        featureFlags: { quotes: true },
        isDemo: false,
        isSeed: false,
        goLiveAt: now,
      });
    }

    /* ------------------------------------------------------ the lead closes */

    /*
     * THE WRITE `deals.advance` REFUSED TO MAKE, and it is still only true
     * because this is one serializable transaction — every partial state
     * below would leave a lead marked converted with nothing behind it.
     *
     * IT USED TO BE LAST, and the order is now load-bearing rather than
     * cosmetic. A converted lead KEEPS its row, so `dispatchToClient` has to
     * ask whether a recipient is a business we are still prospecting, and it
     * excuses exactly the lead that became THIS client — by reading
     * `convertedClientId`. Written after the invoice, that field is still
     * empty when the invoice email is queued, so the client's own invite and
     * their first invoice would both be refused as outreach to a prospect.
     * Silently, with a row in the outbox nobody was watching yet.
     *
     * So: convert first, then tell them. Moving this back down is a working
     * onboarding that reaches nobody, which is the failure mode this whole
     * transaction exists to rule out.
     */
    await patchDoc(ctx, deal.leadId, {
      status: "converted",
      convertedClientId: clientId,
    });

    /* ------------------------------------------------------ access and work */

    const invite = await mintClientOwnerInvite(ctx, {
      clientId,
      email: ownerEmail,
      createdBy: ctx.platform.userId,
    });

    /*
     * AND THE CLIENT IS TOLD. This was the named gap: the invite was minted
     * inside the transaction and then handed back as a plaintext token for
     * somebody to carry out by hand, which meant onboarding worked and the
     * client heard nothing until a phone call happened.
     *
     * NO TOKEN IN THE EMAIL, and that is not an omission. `resolveSignIn`
     * reconciles invites by EMAIL ADDRESS on every sign-in — nothing has ever
     * read `invites.tokenHash` back — so the token grants precisely nothing.
     * Putting one in a link would be handing somebody a credential that is
     * not one: it would appear to work when forwarded, for reasons its holder
     * could not guess, and it would fail for the person who needed it. The
     * email carries the address to sign in at and the instruction that only
     * this email address will be recognised, which is the truth.
     *
     * The plaintext token is still returned below. It is what the invite row
     * is keyed on if the token ever becomes a real credential, and returning
     * it costs nothing.
     */
    const inviteDelivery = await dispatchToClient(ctx, {
      message: { kind: "client.invite", inviteId: invite.inviteId },
      clientId,
      templateKey: "client_invite",
      payload: {
        businessName: lead.businessName,
        signInUrl: clientSignInUrl(slug),
        email: ownerEmail,
      },
      triggeredAt: now,
      now,
    });

    for (const item of CHECKLIST) {
      await ctx.db.insert("onboardingItems", {
        clientId,
        key: item.key,
        label: item.label,
        phase: item.phase,
        owner: item.owner,
        status: "pending",
      });
    }
    if (!demoSite) {
      await ctx.db.insert("onboardingItems", {
        clientId,
        key: "build-site",
        label: "Build the site — this client came in without a demo",
        phase: "build",
        owner: "us",
        status: "pending",
      });
    }

    /* --------------------------------------------------------- the invoice */

    const buildFeeCents = args.buildFeeCents ?? deal.valueCents;
    const invoice = await issueInvoiceFor(ctx, {
      clientId,
      lineItems: [
        {
          description: `Website build — ${lead.businessName}`,
          quantity: 1,
          unitPriceCents: buildFeeCents,
        },
      ],
      paymentTermsDays: args.paymentTermsDays,
      now,
      actorUserId: ctx.platform.userId,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.platform.userId,
      clientId,
      ventureId: lead.ventureId,
      at: now,
      action: "onboarding.convertWonDeal",
      entityTable: "clients",
      entityId: clientId,
      after: { dealId: args.dealId, leadId: deal.leadId, slug, invoice: invoice.number },
    });

    return {
      clientId,
      siteId,
      slug,
      alreadyConverted: false,
      promotedDemo,
      backOffice: `/c/${slug}`,
      inviteId: invite.inviteId,
      /**
       * THE ONLY TIME THE PLAINTEXT EXISTS, and it is no longer load-bearing:
       * the invite is delivered by email above, and sign-in reconciles by
       * address rather than by token. Returned because the row is keyed on it
       * and that costs nothing to hand back.
       */
      inviteToken: invite.token,
      /**
       * WHAT ACTUALLY HAPPENED TO THE TWO MESSAGES, never assumed.
       *
       * The person who just converted a deal is on the phone with the client
       * and can still ask for a different address — the same reasoning as
       * `reachable` on a booking. `queued` is not `sent`; the outbox is what
       * says that.
       */
      inviteDelivery: inviteDelivery.outcome,
      invoiceDelivery: invoice.delivery,
      invoiceNumber: invoice.number,
      paymentReference: invoice.paymentReference,
      invoiceUrl: invoice.viewUrl,
      totalCents: invoice.totalCents,
    };
  },
});

/** A slug nobody holds. Same shape as the demo builder's, same reasoning. */
async function freeSlug(ctx: MutationCtx, businessName: string): Promise<string> {
  const base =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "client";

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await ctx.db
      .query("clients")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .first();
    if (!taken) return candidate;
  }
  throw bad("SLUG_EXHAUSTED", `Could not find a free slug for "${businessName}".`);
}
