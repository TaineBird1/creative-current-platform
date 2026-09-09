import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ownerMutation } from "./lib/functions";
import { toE164 } from "./lib/phone";
import { existingLeadKeys } from "./lib/leadAccess";

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

const importArgs = {
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
        /** Suburb or town. A demo needs it: the site names where they work. */
        area: v.optional(v.string()),
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
} as const;

type ImportArgs = {
  ventureId: Id<"ventures">;
  niche: string;
  source: "places" | "sa_venues" | "campaign_list" | "referral" | "inbound";
  lawfulBasis: "consent" | "legitimate_interest";
  capturedAt: number;
  rows: Array<{
    businessName: string;
    phone?: string;
    website?: string;
    area?: string;
    placeId?: string;
    detail: string;
    auditFaults?: string[];
    callNote?: string;
    ownerName?: string;
    ownerNameConfidence?: "low" | "medium" | "high";
    ownerNameSource?: string;
  }>;
};

async function runImport(ctx: MutationCtx, args: ImportArgs) {
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

    /*
     * THIS FILE NO LONGER READS THE LEADS TABLE, and that is what let the
     * import have a screen at all.
     *
     * It used to `collect()` the table here, on an allowlist whose stated
     * safety condition was that nothing in a browser could reach this module.
     * That was a real property and the right one — so rather than widen the
     * exemption to add a console, the read moved to `lib/leadAccess.ts`,
     * which is already the only thing permitted to read leads and which hands
     * back two sets of KEYS. No lead document reaches this function.
     */
    const { phones: byPhone, names: byName } = await existingLeadKeys(ctx);

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
        (phone !== null && byPhone.has(phone)) || byName.has(name.toLowerCase());

      if (duplicate) {
        // Left exactly as it is. Its provenance is already recorded, and
        // rewriting it here would be the backfill the guard test forbids.
        skipped++;
        continue;
      }

      if (!phone) withoutPhone++;

      await ctx.db.insert("leads", {
        ventureId: args.ventureId,
        placeId: row.placeId,
        businessName: name,
        niche: args.niche,
        phone: phone ?? undefined,
        // The source string, kept whole. It is what a person recognises, and
        // it holds any second number the key had to drop.
        phoneDisplay: row.phone?.trim() || undefined,
        website: row.website?.trim() || undefined,
        area: row.area?.trim() || undefined,
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

      /* Within-batch dedupe: a file listing the same business twice is
         ordinary, and the second one must not become a second row. */
      if (phone) byPhone.add(phone);
      byName.add(name.toLowerCase());
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
}

/**
 * THE CLI PATH, kept. A big first import is a file, and a file is easier to
 * run from a terminal than to paste into a textarea.
 */
export const importLeads = internalMutation({
  args: importArgs,
  handler: (ctx, args) => runImport(ctx, args as ImportArgs),
});

/**
 * THE CONSOLE PATH, which this module could not have had before.
 *
 * It reads no leads — `existingLeadKeys` does, in the one module allowed to —
 * so the exemption that kept every export here internal is gone rather than
 * widened. What this returns is counts plus the names of rows in the
 * caller's OWN file whose number would not parse; nothing about a lead
 * already in the table reaches the browser.
 *
 * Owner-gated, not merely platform: an import writes provenance that can
 * never be corrected afterwards, so it is the same level of decision as
 * naming the issuer.
 */
export const importFromConsole = ownerMutation({
  args: importArgs,
  handler: (ctx, args) => runImport(ctx, args as ImportArgs),
});
