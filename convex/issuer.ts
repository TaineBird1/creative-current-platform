import { v, ConvexError } from "convex/values";
import { ownerMutation, platformQuery } from "./lib/functions";

/**
 * WHO IS ISSUING THE INVOICE.
 *
 * A South African sole proprietor invoices in their own name. There is no
 * registration number, nothing to apply for and nothing to wait for — the
 * legal person is you. `registrationNumber` appears if and when a Pty Ltd is
 * formed, and its absence is the ordinary case rather than an unfinished
 * field.
 *
 * `vatNumber` is absent until VAT registration, which is compulsory only
 * above R1m turnover. While it is absent no invoice renders a VAT line,
 * because charging VAT you are not registered for is a much worse problem
 * than not charging it: the money is not yours and SARS wants it regardless.
 *
 * Set per VENTURE. One person can trade as a sole prop for consulting and
 * form a company for the sites business, and on the day that happens only one
 * venture's issuer changes — while every invoice already sent keeps the
 * snapshot it was issued under.
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

export const set = ownerMutation({
  args: {
    ventureId: v.id("ventures"),
    legalName: v.string(),
    tradingName: v.optional(v.string()),
    registrationNumber: v.optional(v.string()),
    vatNumber: v.optional(v.string()),
    addressLine: v.string(),
    suburb: v.optional(v.string()),
    city: v.string(),
    postalCode: v.optional(v.string()),
    countryCode: v.optional(v.string()),
    email: v.string(),
    phone: v.optional(v.string()),
    bankName: v.optional(v.string()),
    bankAccountName: v.optional(v.string()),
    bankAccountNumber: v.optional(v.string()),
    bankBranchCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const venture = await ctx.db.get(args.ventureId);
    if (!venture) throw bad("NO_SUCH_VENTURE", "No such venture.");

    const legalName = args.legalName.trim();
    if (legalName.length < 2) {
      throw bad(
        "INVALID",
        "An invoice has to say who is issuing it. For a sole proprietor that is your own full name.",
      );
    }
    if (!args.addressLine.trim() || !args.city.trim()) {
      throw bad("INVALID", "An invoice needs an address a client can write to.");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.email.trim())) {
      throw bad("INVALID", "An invoice needs an email a client can reply to.");
    }

    /*
     * A VAT number without registration is the one field here that can cause
     * real harm, so it is shaped-checked. SA VAT numbers are 10 digits
     * starting with 4. This does not prove registration — nothing here can —
     * it only stops a typo turning into a VAT line on a real document.
     */
    const vatNumber = args.vatNumber?.trim() || undefined;
    if (vatNumber && !/^4\d{9}$/.test(vatNumber)) {
      throw bad(
        "INVALID_VAT",
        "A South African VAT number is 10 digits beginning with 4. Leave it blank until you are registered — invoices then carry no VAT line, which is correct.",
      );
    }

    const existing = await ctx.db
      .query("issuers")
      .withIndex("by_venture", (q) => q.eq("ventureId", args.ventureId))
      .unique();

    const row = {
      ventureId: args.ventureId,
      legalName,
      tradingName: args.tradingName?.trim() || undefined,
      registrationNumber: args.registrationNumber?.trim() || undefined,
      vatNumber,
      addressLine: args.addressLine.trim(),
      suburb: args.suburb?.trim() || undefined,
      city: args.city.trim(),
      postalCode: args.postalCode?.trim() || undefined,
      countryCode: (args.countryCode ?? "ZA").trim().toUpperCase(),
      email: args.email.trim(),
      phone: args.phone?.trim() || undefined,
      bankName: args.bankName?.trim() || undefined,
      bankAccountName: args.bankAccountName?.trim() || undefined,
      bankAccountNumber: args.bankAccountNumber?.trim() || undefined,
      bankBranchCode: args.bankBranchCode?.trim() || undefined,
      updatedAt: Date.now(),
    };

    /*
     * Editing this changes NOTHING already issued. Every invoice snapshotted
     * its issuer at the moment it was created, so converting to a Pty Ltd or
     * correcting a bank account cannot rewrite documents a client is holding.
     */
    if (existing) {
      await ctx.db.replace(existing._id, row);
      return { issuerId: existing._id, created: false };
    }
    return { issuerId: await ctx.db.insert("issuers", row), created: true };
  },
});

export const get = platformQuery({
  args: { ventureId: v.id("ventures") },
  handler: async (ctx, { ventureId }) => {
    const issuer = await ctx.db
      .query("issuers")
      .withIndex("by_venture", (q) => q.eq("ventureId", ventureId))
      .unique();

    if (!issuer) return null;
    return {
      ...issuer,
      /*
       * Said in the return value rather than left to be inferred from an
       * absent field. "No VAT number" and "VAT not charged" are the same fact
       * and a screen should not have to work that out.
       */
      chargesVat: Boolean(issuer.vatNumber),
      /** A sole prop has no registration number, and that is not a gap. */
      isSoleProprietor: !issuer.registrationNumber,
    };
  },
});
