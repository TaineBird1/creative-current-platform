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

/**
 * VALUES THAT LOOK REAL AND ARE NOT.
 *
 * The specific hazard: a legal name invented by a seed script, a test
 * fixture, or an assistant filling in a form it could not leave blank. An
 * EMPTY field refuses on its own and is therefore safe. A plausible one
 * prints at the top of a document a client keeps, and nothing errors.
 *
 * Matched on whole words so a real name containing one of these as a
 * substring is not caught — "Testa" is a surname, "Test" is not.
 *
 * This list cannot be complete and is not meant to be. It catches the values
 * that actually exist in this repository and the handful every codebase
 * accumulates; `confirmedAt` is what catches the rest, because the only
 * thing that can tell an invented name from a real one is a person.
 */
export const PLACEHOLDER =
  /\b(test|testing|example|sample|placeholder|todo|tbd|acme|foo|bar|lorem|ipsum|your name|john doe|jane doe|dummy|xxx)\b/i;

function refusePlaceholder(field: string, value: string | undefined) {
  if (!value) return;
  if (PLACEHOLDER.test(value)) {
    throw bad(
      "PLACEHOLDER_VALUE",
      `"${value}" looks like placeholder data, and this prints on documents a client keeps. Put the real ${field} in, or leave it out — an empty field refuses safely, a plausible one does not.`,
    );
  }
}

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

    /*
     * Checked on the fields that reach the document. A placeholder in a bank
     * account number is caught by the client not paying; a placeholder in a
     * legal name is not caught by anything.
     */
    refusePlaceholder("legal name", legalName);
    refusePlaceholder("trading name", args.tradingName?.trim());
    refusePlaceholder("address", args.addressLine.trim());
    refusePlaceholder("email", args.email.trim());

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
      /*
       * EVERY EDIT CLEARS CONFIRMATION. Changing an address after somebody
       * confirmed the row means what they confirmed is no longer what would
       * print, and carrying the old approval forward would make the check
       * decorative — approved once, changed freely afterwards.
       */
      confirmedAt: undefined,
      confirmedBy: undefined,
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

/**
 * A person says the details are right, by typing the legal name back.
 *
 * Re-typing rather than a checkbox, and the difference is the whole point: a
 * checkbox can be ticked without reading, and the thing being guarded against
 * is precisely a value nobody read. Typing the name means the name was looked
 * at — which is the only check that can tell an invented one from a real one.
 */
export const confirm = ownerMutation({
  args: { ventureId: v.id("ventures"), legalName: v.string() },
  handler: async (ctx, args) => {
    const issuer = await ctx.db
      .query("issuers")
      .withIndex("by_venture", (q) => q.eq("ventureId", args.ventureId))
      .unique();
    if (!issuer) throw bad("NO_ISSUER", "There is no issuer to confirm. Set one first.");

    if (args.legalName.trim() !== issuer.legalName) {
      throw bad(
        "NAME_MISMATCH",
        `That does not match the stored legal name. The stored one is "${issuer.legalName}" — if that is wrong, fix it with issuer.set rather than confirming it.`,
      );
    }

    refusePlaceholder("legal name", issuer.legalName);

    const now = Date.now();
    await ctx.db.patch(issuer._id, { confirmedAt: now, confirmedBy: ctx.platform.userId });
    return { confirmedAt: now };
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
      /** False means nothing can be invoiced yet. Said, not left to infer. */
      confirmed: issuer.confirmedAt !== undefined,
    };
  },
});
