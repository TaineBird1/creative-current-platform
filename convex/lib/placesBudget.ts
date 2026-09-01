import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertCents, sumCents, type Currency } from "./money";

/**
 * THE SPEND CAP, ENFORCED STRUCTURALLY.
 *
 * A cap written as `if (calls > 500) return` is a constant somebody has to
 * remember to compare against, in every loop, forever. This is a ledger
 * instead: the run writes what it is about to spend, reads the period's
 * total, and is refused above the cap. One choke point, one guard test, and
 * no caller that can forget — the same shape as the demo/seed block in
 * dispatch, chosen for the same reason.
 *
 * RESERVED BEFORE THE CALL, NEVER AFTER, AND NEVER REFUNDED.
 *
 * The two errors cost differently. Charging for a request that then failed
 * over-counts, refuses a call we could have afforded, and is fixed by raising
 * the cap — recoverable, and visible in the ledger as a run that stopped
 * early. Charging after a successful response under-counts every request that
 * crashed mid-flight, and that money is already spent — not recoverable.
 *
 * So there is no refund path here on purpose. A refund is how a retry loop
 * turns a cap into a suggestion: fail, refund, retry, fail, refund, and the
 * bill grows while the ledger stays flat.
 */

const bad = (code: string, message: string) => new ConvexError({ code, message });

/** "2026-08". The cap is per calendar month, in UTC, so it is unambiguous. */
export function periodFor(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type Provider = "google_places" | "google_geocoding";

export async function spentThisPeriod(
  ctx: QueryCtx,
  provider: Provider,
  at: number,
): Promise<{ cents: number; currency: Currency } | null> {
  const period = periodFor(at);
  const rows = (
    await ctx.db
      .query("apiSpend")
      .withIndex("by_provider_at", (q) => q.eq("provider", provider))
      .collect()
  ).filter((row) => periodFor(row.at) === period);

  if (rows.length === 0) return null;
  const currency = rows[0]!.currency;
  // sumCents throws on a mixed-currency array rather than producing a
  // meaningless total — a cap compared against one of those is not a cap. It
  // wants `amountCents`, so the spend rows are mapped rather than the money
  // helper being loosened: one summing function, one currency rule.
  return {
    cents: sumCents(
      rows.map((row) => ({ amountCents: row.costCents, currency: row.currency })),
      currency,
    ),
    currency,
  };
}

/**
 * Charge for a call BEFORE making it, or refuse.
 *
 * The ONLY writer of `apiSpend`, enforced by guards.test.ts. Returns the new
 * running total so a caller can log it; throws `SPEND_CAP` when the charge
 * would cross the cap, and the run is expected to stop rather than catch it.
 *
 * A MISSING CAP IS A REFUSAL. There is no default cap and no unlimited mode:
 * an unconfigured deployment that spends freely is exactly the failure this
 * file exists to prevent, and it is the shape that costs real money before
 * anyone notices. Same reasoning as a missing webhook secret.
 */
export async function reserveSpend(
  ctx: MutationCtx,
  input: { provider: Provider; operation: string; units: number; at: number; runId?: string },
): Promise<{ costCents: number; spentCents: number; capCents: number; currency: Currency }> {
  if (!Number.isInteger(input.units) || input.units <= 0) {
    throw bad("INVALID", "units must be a positive whole number of API calls");
  }

  const period = periodFor(input.at);
  const cap = await ctx.db
    .query("spendCaps")
    .withIndex("by_provider_period", (q) =>
      q.eq("provider", input.provider).eq("period", period),
    )
    .unique();

  if (!cap) {
    throw bad(
      "NO_SPEND_CAP",
      `No spend cap is set for ${input.provider} in ${period}. Sourcing will not run without one — an uncapped loop over a paid API is an invoice, not an error.`,
    );
  }

  const unitCostCents = cap.unitCostCents[input.operation];
  if (unitCostCents === undefined) {
    throw bad(
      "UNPRICED_OPERATION",
      `${input.operation} has no unit price in the ${period} cap. An operation we cannot cost cannot be capped, so it is refused rather than counted as free.`,
    );
  }

  const costCents = assertCents(unitCostCents * input.units, "costCents");
  const spent = await spentThisPeriod(ctx, input.provider, input.at);

  if (spent && spent.currency !== cap.currency) {
    throw bad(
      "CURRENCY_MISMATCH",
      `The ${period} spend is in ${spent.currency} and the cap is in ${cap.currency}. Refusing to compare them.`,
    );
  }

  const already = spent?.cents ?? 0;
  if (already + costCents > cap.capCents) {
    throw bad(
      "SPEND_CAP",
      `The ${period} ${input.provider} cap of ${cap.capCents} cents is reached (${already} spent, this call costs ${costCents}). Raise the cap deliberately or wait for the next period.`,
    );
  }

  /*
   * Written before the caller makes the request, and the transaction commits
   * this whether or not the request then succeeds. That is the direction to
   * be wrong in — see the module note.
   */
  await ctx.db.insert("apiSpend", {
    provider: input.provider,
    operation: input.operation,
    units: input.units,
    costCents,
    currency: cap.currency,
    at: input.at,
    runId: input.runId,
  });

  return {
    costCents,
    spentCents: already + costCents,
    capCents: cap.capCents,
    currency: cap.currency,
  };
}
