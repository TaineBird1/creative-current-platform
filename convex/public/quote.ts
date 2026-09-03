import { v, ConvexError } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { safeParseSiteConfig } from "@cc/site-config";
import { hashToken } from "../lib/invites";
import { toE164 } from "../lib/phone";

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

    /*
     * THE FORM IS TOLD WHAT HAPPENED, RATHER THAN ASSUMING.
     *
     * A demo submission is recorded as engagement and reaches nobody. Left to
     * answer for itself the form says "Thanks — that is with us", and a real
     * customer who found the demo walks away believing a tradesman is coming.
     * That is the same fail-open shape as the rest of the demo rules: silence
     * reads as success.
     *
     * The verdict is decided HERE because this is the only place that knows
     * whether anything was actually dispatched. A template that had to work
     * it out for itself is a template that can be wrong, and the one that is
     * wrong leaves somebody waiting in for an appointment nobody booked.
     */
    const recorded = !site.isDemo;

    /*
     * A NUMBER WE CANNOT MESSAGE IS SAID OUT LOUD, HERE, NOW.
     *
     * A number that does not reach E.164 cannot be checked against the
     * do-not-call list, so `dispatch` suppresses every message to it — see
     * lib/phone.ts. That is the right call and it is INVISIBLE to the person
     * who just typed it: they submit, the confirmation is silently dropped,
     * and they wait for a message that was never going to arrive.
     *
     * Exactly the failure the demo form has, and it gets the same answer: the
     * backend knows, so the backend says so at the moment of submission. The
     * outbox row explaining the suppression is visible to the BUSINESS; the
     * customer sees nothing unless we tell them.
     *
     * The request is still recorded. Refusing the number would turn a
     * messaging limitation into a lost enquiry, which is worse for everyone.
     */
    const reachable = toE164(args.phone).ok;

    return {
      ok: true as const,
      requestId,
      recorded,
      reachable,
      notice: !recorded
        ? {
            title: "This is a preview — nothing was booked.",
            body:
              "This page is a proposal prepared by The Creative Current to show " +
              "what a website could look like. It is not this business's site, " +
              "no request has been sent to them, and nobody will call you. " +
              "Please contact the business directly.",
          }
        : !reachable
          ? {
              title: "We have your request — we will phone you.",
              body:
                "That number is not a South African mobile, so we cannot send " +
                "you a WhatsApp or SMS confirmation. Your request has gone " +
                "through and someone will call you on it. If you would rather " +
                "have written confirmation, reply with a South African number.",
            }
          : null,
    };
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
/**
 * ACCEPTING — the customer agreeing to a price.
 *
 * The closest thing in this system to signing something, and it is treated
 * that way: what they agreed to is SNAPSHOTTED onto a `quoteAcceptances` row
 * at the moment they agree, not left to be read off a quote that staff can
 * edit afterwards. Without that, "what did they agree to" is answerable only
 * as "whatever it says now" — which is no answer at all when the disagreement
 * is about a price, and that is the only time anybody asks.
 *
 * IDEMPOTENT, because the usage scene demands it: a customer on a phone with
 * one bar, on a page that took a moment to respond, taps Accept twice. That
 * must produce ONE acceptance. Two guards, because one is a race:
 *   - the status check below refuses anything that is not `sent`, and
 *   - the `by_quote` read refuses a second row even if the status were wrong.
 * Both run inside one serializable mutation, so two concurrent taps conflict
 * and one retries into the already-accepted branch rather than both inserting.
 *
 * A SECOND TAP IS NOT AN ERROR. It returns the acceptance that exists, so the
 * page shows "Accepted" — which is true, and is what the customer meant. An
 * error there would tell somebody who successfully accepted that they had
 * failed, and they would ring the business about it.
 *
 * WITHDRAWN, EXPIRED AND UNSENT ALL REFUSE, each with its own sentence,
 * because they need different actions from the reader: ask for a new one, ask
 * for an updated one, and wait respectively.
 */
export const accept = mutation({
  args: { token: v.string() },
  handler: async (
    ctx,
    { token },
  ): Promise<{
    number: string;
    totalCents: number;
    currency: string;
    alreadyAccepted: boolean;
    /** False when the branch was ambiguous — staff must create the job. */
    jobCreated: boolean;
  }> => {
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

    /*
     * THE ACCEPTANCE IS THE RECORD, so it is what gets checked for a repeat —
     * not the quote's status, which is a mutable field on a mutable row.
     */
    const existing = await ctx.db
      .query("quoteAcceptances")
      .withIndex("by_quote", (q) => q.eq("quoteId", quote._id))
      .unique();

    if (existing) {
      return {
        number: existing.number,
        totalCents: existing.totalCents,
        currency: existing.currency,
        alreadyAccepted: true,
        jobCreated: false,
      };
    }

    /*
     * An accepted quote with no acceptance row predates this table. Report it
     * as accepted rather than accepting it again — inventing a snapshot now
     * would be a guess about the past dressed as a record of it, which is the
     * same refusal `leads.provenance` makes.
     */
    if (quote.status === "accepted") {
      return {
        number: quote.number,
        totalCents: quote.totalCents,
        currency: quote.currency,
        alreadyAccepted: true,
        jobCreated: false,
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
    /*
     * WHICH BRANCH? Only answer when there is one answer.
     *
     * This used `.first()` on the client's locations, which for a multi-branch
     * business assigned the job to whichever row the scan happened to return —
     * a crew dispatched from the wrong depot, decided by database ordering. A
     * tie that decides a FACT may not be broken arbitrarily.
     *
     * So: exactly one active location means the branch is unambiguous and the
     * job is created. Zero or several means we do not know, and guessing is
     * worse than not knowing. The ACCEPTANCE still stands either way — that is
     * the customer's act and it is recorded above — and staff create the job
     * choosing the branch, which they can do and we cannot.
     */
    const locations = await ctx.db
      .query("locations")
      .withIndex("by_client", (q) => q.eq("clientId", quote.clientId))
      .collect();
    const active = locations.filter((row) => row.active);
    const location = active.length === 1 ? active[0]! : null;

    let jobId: Id<"jobs"> | undefined;
    if (location) {
      jobId = await ctx.db.insert("jobs", {
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

    /*
     * THE SNAPSHOT. Everything the customer read, copied rather than
     * referenced, so this row answers "what did they agree to" on its own
     * however the quote is edited afterwards.
     */
    await ctx.db.insert("quoteAcceptances", {
      clientId: quote.clientId,
      quoteId: quote._id,
      customerId: quote.customerId,
      number: quote.number,
      lineItems: quote.lineItems.map((line) => ({ ...line })),
      subtotalCents: quote.subtotalCents,
      totalCents: quote.totalCents,
      currency: quote.currency,
      validUntil: quote.expiresAt,
      acceptedAt: now,
      ...(jobId ? { jobId } : {}),
      isDemo: quote.isDemo,
    });

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
      jobCreated: location !== null,
    };
  },
});

/**
 * THE QUOTE, TO WHOEVER HOLDS THE LINK.
 *
 * `accept` existed without this, which meant the only thing a customer could
 * do with a quote link was agree to a number they could not see. Nobody
 * accepts a price sight unseen, so in practice the link was unusable and the
 * whole quote flow stopped at the back office.
 *
 * Same shape as `public/invoice.view`, and for the same reasons: the token is
 * the credential because the reader has no account and never will; one
 * document and nothing else; assembled field by field so a column added to
 * `quotes` is never published by accident.
 *
 * WHY THE CLIENT NAME IS JOINED, when `public/invoice.view` deliberately does
 * not join `clients`. There it was avoidable — the invoice snapshots
 * `billToName`. Here the customer has to be told WHO is quoting them, and a
 * quote that does not name the business is not a document anybody would act
 * on. The disclosure is narrow and not enumerable: it takes the 256-bit token
 * for one specific quote to learn one business's trading name, which that
 * business publishes on its own website anyway. Nothing else about the client
 * is returned, and no id of any kind is.
 *
 * IT DOES NOT LEAK WHETHER A LINK IS MERELY WRONG. One refusal sentence for
 * unknown and mistyped, exactly as `accept` does, so the two agree.
 */
export const view = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const tokenHash = await hashToken(token);

    const quote = await ctx.db
      .query("quotes")
      .withIndex("by_acceptTokenHash", (q) => q.eq("acceptTokenHash", tokenHash))
      .unique();

    if (!quote) throw rejected("that link is not valid");
    if (quote.status === "draft") throw rejected("that quote has not been sent yet");
    if (quote.status === "declined") throw rejected("that quote was withdrawn");

    const client = await ctx.db.get(quote.clientId);

    /*
     * Expiry is REPORTED, not refused. A customer who opens an expired quote
     * needs to be told it lapsed and what to do about it — refusing the link
     * outright reads as a broken message and sends them to ring up asking why
     * nothing works.
     */
    const expired = quote.status !== "accepted" && quote.expiresAt < Date.now();

    return {
      number: quote.number,
      businessName: client?.name ?? null,
      lineItems: quote.lineItems.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        lineTotalCents: Math.round(line.unitPriceCents * line.quantity),
      })),
      subtotalCents: quote.subtotalCents,
      totalCents: quote.totalCents,
      currency: quote.currency,
      expiresAt: quote.expiresAt,
      expired,
      accepted: quote.status === "accepted",
      acceptedAt: quote.acceptedAt ?? null,
      /** Whether pressing accept would do anything. The page asks, not guesses. */
      acceptable: quote.status === "sent" && !expired,
    };
  },
});
