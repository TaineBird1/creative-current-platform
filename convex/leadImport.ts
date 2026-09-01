import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import { toE164 } from "./lib/phone";

/**
 * BULK IMPORT, WITH THE PROVENANCE THAT MAKES IT DEFENSIBLE.
 *
 * An import is where provenance is most likely to be lost and most likely to
 * be needed. A batch arrives as a file, the file came from somewhere, and six
 * months later the only person who remembers where is the one who ran it —
 * which is exactly the situation "where did you get my number" is asked in.
 *
 * So every row carries its own `detail`. The batch-level source says
 * `campaign_list`; the detail names the specific directory THIS business was
 * listed in, because "from a campaign list" is not an answer and "you are
 * listed on SolarZA, which is where I found you" is.
 *
 * IDEMPOTENT ON PHONE, then on name. Re-running an import is normal — a file
 * gets corrected and run again — and the failure mode of a non-idempotent one
 * is a lead appearing twice in a queue and a business being phoned twice by
 * the same person. Existing rows are LEFT ALONE rather than updated: their
 * provenance is already recorded and overwriting it would be the backfill the
 * guard test exists to prevent.
 */

const source = v.union(
  v.literal("places"),
  v.literal("sa_venues"),
  v.literal("campaign_list"),
  v.literal("referral"),
  v.literal("inbound"),
);

export const importLeads = internalMutation({
  args: {
    ventureId: v.id("ventures"),
    niche: v.string(),
    source,
    lawfulBasis: v.union(v.literal("consent"), v.literal("legitimate_interest")),
    /** When the ORIGINAL pull happened, not when this import ran. */
    capturedAt: v.number(),
    rows: v.array(
      v.object({
        businessName: v.string(),
        phone: v.optional(v.string()),
        website: v.optional(v.string()),
        placeId: v.optional(v.string()),
        /** The specific directory or search this row came from. */
        detail: v.string(),
        auditFaults: v.optional(v.array(v.string())),
        callNote: v.optional(v.string()),
        ownerName: v.optional(v.string()),
        ownerNameConfidence: v.optional(
          v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
        ),
        ownerNameSource: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const venture = await ctx.db.get(args.ventureId);
    if (!venture) {
      throw new ConvexError({ code: "NO_SUCH_VENTURE", message: "No such venture." });
    }

    /*
     * `capturedAt` is the ORIGINAL pull, and a future one is a typo rather
     * than a fact. Refused, because a capture date later than today makes the
     * whole record read as invented — which is the opposite of what it is for.
     */
    if (args.capturedAt > Date.now()) {
      throw new ConvexError({
        code: "CAPTURED_IN_THE_FUTURE",
        message: "capturedAt is when the list was originally pulled. It cannot be in the future.",
      });
    }

    const existing = await ctx.db.query("leads").collect();
    /*
     * Keyed on the STORED E.164, which is already canonical — re-normalising
     * it here would be a second opinion about a value lib/phone.ts has
     * already decided, and second opinions are how the two normalisers this
     * codebase used to have came about.
     */
    const byPhone = new Map(existing.filter((row) => row.phone).map((row) => [row.phone!, row]));
    const byName = new Map(existing.map((row) => [row.businessName.trim().toLowerCase(), row]));

    let created = 0;
    let skipped = 0;
    let withoutPhone = 0;
    /** Rows whose number is present but unusable. Named, not merged with blanks. */
    const unusable: string[] = [];

    for (const row of args.rows) {
      const name = row.businessName.trim();
      if (!name) continue;

      const parsed = toE164(row.phone);
      const phone = parsed.ok ? parsed.e164 : null;
      if (row.phone?.trim() && !parsed.ok) unusable.push(`${name}: ${parsed.reason}`);

      const duplicate =
        (phone && byPhone.get(phone)) || byName.get(name.toLowerCase()) || null;

      if (duplicate) {
        // Left exactly as it is. Its provenance is already recorded, and
        // rewriting it here would be the backfill the guard test forbids.
        skipped++;
        continue;
      }

      if (!phone) withoutPhone++;

      const leadId = await ctx.db.insert("leads", {
        ventureId: args.ventureId,
        placeId: row.placeId,
        businessName: name,
        niche: args.niche,
        phone: phone ?? undefined,
        // The source string, kept whole. It is what a person recognises, and
        // it holds any second number the key had to drop.
        phoneDisplay: row.phone?.trim() || undefined,
        website: row.website?.trim() || undefined,
        auditFaults: row.auditFaults ?? [],
        callNote: row.callNote?.trim() || undefined,
        ownerName: row.ownerName?.trim() || undefined,
        ownerNameConfidence: row.ownerNameConfidence,
        ownerNameSource: row.ownerNameSource?.trim() || undefined,
        status: "new",
        provenance: {
          source: args.source,
          capturedAt: args.capturedAt,
          lawfulBasis: args.lawfulBasis,
          detail: row.detail,
        },
      });

      if (phone) byPhone.set(phone, (await ctx.db.get(leadId))!);
      byName.set(name.toLowerCase(), (await ctx.db.get(leadId))!);
      created++;
    }

    /*
     * `withoutPhone` and `unusable` are reported rather than buried, and they
     * are counted apart on purpose. A blank number is a row nobody has
     * researched yet; a number that failed to parse is a row with a TYPO in
     * it, and those are worth fixing rather than re-researching. Merged into
     * one figure, the typos hide inside the blanks forever.
     */
    return { created, skipped, withoutPhone, unusable };
  },
});
