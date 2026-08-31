import { v, ConvexError } from "convex/values";
import { mutation } from "../_generated/server";
import { safeParseSiteConfig } from "@cc/site-config";
import { hashToken } from "../lib/invites";

/**
 * PUBLIC, UNAUTHENTICATED. On the PUBLIC_ALLOWLIST in guards.test.ts.
 *
 * The quote flow for template #1 (solar/trades). Zero friction: name and
 * phone are the only required fields, and there is no end-customer account
 * anywhere in this file.
 *
 * The tenant is NOT taken from the request. It is derived from the site the
 * form was rendered on: slug -> site -> site.clientId. A caller who forges a
 * slug can only ever submit a lead into the site whose form they are looking
 * at, which is what the form is for.
 */

const rejected = (message: string) => new ConvexError({ code: "REJECTED", message });

export const submit = mutation({
  args: {
    slug: v.string(),
    sectionId: v.string(),
    name: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    answers: v.record(v.string(), v.string()),
    photoStorageIds: v.optional(v.array(v.id("_storage"))),
    consentAccepted: v.boolean(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.consentAccepted) throw rejected("consent is required");
    if (args.name.trim().length < 2) throw rejected("name is required");
    if (!/^\+?[0-9 ()-]{7,20}$/.test(args.phone)) throw rejected("a valid phone is required");

    const site = await ctx.db
      .query("sites")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!site) throw rejected("unknown site");
    if (site.status === "archived") throw rejected("site is not accepting submissions");

    const parsed = safeParseSiteConfig(site.publishedConfig ?? site.config);
    if (!parsed.success) throw rejected("site is not accepting submissions");

    const section = parsed.data.sections.find(
      (s) => s.id === args.sectionId && s.type === "quote",
    );
    if (!section || section.type !== "quote") throw rejected("unknown form");

    // Required fields come from the CONFIG, not from the browser's idea of them.
    for (const field of section.fields) {
      if (field.required && !args.answers[field.key]?.trim()) {
        throw rejected(`${field.label} is required`);
      }
    }
    // Silently drop answers to fields the section does not declare.
    const answers: Record<string, string> = {};
    for (const field of section.fields) {
      const value = args.answers[field.key];
      if (value !== undefined) answers[field.key] = value.slice(0, 2000);
    }

    const requestId = await ctx.db.insert("quoteRequests", {
      clientId: site.clientId,
      siteId: site._id,
      name: args.name.trim(),
      phone: args.phone.trim(),
      email: args.email?.trim(),
      answers,
      photoStorageIds: args.photoStorageIds ?? [],
      status: "new",
      consentText: section.consentText,
      lawfulBasis: "consent",
      submittedAt: Date.now(),
      userAgent: args.userAgent?.slice(0, 300),
      // A demo site produces demo submissions. They are never real leads and
      // the dispatch layer refuses to message them.
      isDemo: site.isDemo || site.status === "demo",
    });

    // Demo engagement lands on the LEAD, not on a tenant.
    if (site.isDemo && site.leadId) {
      await ctx.db.insert("demoEngagements", {
        siteId: site._id,
        leadId: site.leadId,
        kind: "quote_tested",
        at: Date.now(),
      });
    }

    return { ok: true as const, requestId };
  },
});

/**
 * ACCEPT A QUOTE BY LINK. Public and unauthenticated, on purpose — the
 * customer has no account and never will.
 *
 * The token is the whole authorisation. It is looked up BY HASH, so the
 * plaintext never exists in the database and a leak does not hand an attacker
 * the ability to accept work in someone's name. Same reasoning as an invite.
 *
 * The tenant is derived from the quote the token resolves to, never supplied
 * by the caller. There is no slug argument here for exactly that reason: a
 * forged one would be an attempt to accept another business's quote.
 *
 * Accepting is IDEMPOTENT. Customers double-tap links, mail clients prefetch
 * them, and WhatsApp previews fetch them unprompted. A second accept returns
 * the same job rather than creating a second one — a duplicate job means a
 * crew dispatched twice to a driveway that needed them once.
 */
export const accept = mutation({
  args: { token: v.string() },
  handler: async (
    ctx,
    { token },
  ): Promise<{ number: string; totalCents: number; currency: string; alreadyAccepted: boolean }> => {
    const tokenHash = await hashToken(token);

    const quote = await ctx.db
      .query("quotes")
      .withIndex("by_acceptTokenHash", (q) => q.eq("acceptTokenHash", tokenHash))
      .unique();

    /*
     * One message for "no such token" and "wrong token", deliberately. A
     * distinct "that quote exists but this token is wrong" tells a stranger
     * which links are real.
     */
    if (!quote) throw rejected("that link is not valid");

    if (quote.status === "accepted") {
      return {
        number: quote.number,
        totalCents: quote.totalCents,
        currency: quote.currency,
        alreadyAccepted: true,
      };
    }

    if (quote.status === "declined") throw rejected("that quote was withdrawn");
    if (quote.status === "draft") throw rejected("that quote has not been sent yet");
    if (quote.expiresAt < Date.now()) {
      throw rejected("that quote has expired — ask for an updated one");
    }

    const now = Date.now();
    await ctx.db.patch(quote._id, { status: "accepted", acceptedAt: now });

    /*
     * Accepting creates the JOB. That is the point of the link: the customer
     * says yes and work exists, without anyone re-keying it.
     *
     * No calendar time is reserved here. A job does not hold a slot — the
     * hours a crew is on site are bookings created against this job — and
     * quietly reserving time from a public endpoint would let anyone with a
     * link block a business's calendar.
     */
    const customer = await ctx.db.get(quote.customerId);
    const location = customer
      ? await ctx.db
          .query("locations")
          .withIndex("by_client", (q) => q.eq("clientId", quote.clientId))
          .first()
      : null;

    if (location) {
      await ctx.db.insert("jobs", {
        clientId: quote.clientId,
        quoteId: quote._id,
        customerId: quote.customerId,
        locationId: location._id,
        status: "accepted",
        crewUserIds: [],
        photoStorageIds: [],
        materials: [],
        currency: quote.currency,
      });
    }

    await ctx.db.insert("auditLog", {
      clientId: quote.clientId,
      action: "quote.acceptedByCustomer",
      entityTable: "quotes",
      entityId: quote._id,
      before: { status: quote.status },
      after: { status: "accepted", acceptedAt: now },
      at: now,
    });

    return {
      number: quote.number,
      totalCents: quote.totalCents,
      currency: quote.currency,
      alreadyAccepted: false,
    };
  },
});
