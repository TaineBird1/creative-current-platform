import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { createBooking } from "./bookings";
import { toE164, toStorageKey } from "./lib/phone";

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
      await ctx.db.patch(existing._id, { email: required(args.customerEmail, "The email") });
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
