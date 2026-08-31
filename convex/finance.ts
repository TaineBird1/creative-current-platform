import { v } from "convex/values";
import { isRevenue } from "./lib/ledger";
import { byOrderThenName } from "./lib/ordering";
import { platformQuery } from "./lib/functions";
import { sumCents, type Currency } from "./lib/money";

/**
 * PER-VENTURE P&L — "what is each thing actually making me".
 *
 * Composed here rather than stitched together in the screen, for one reason
 * that is not tidiness: WHAT IS MISSING has to travel with the numbers.
 *
 * Most of a full P&L does not exist yet. Commissions, subscriptions and
 * invoiced revenue arrive with M4 and M5. A screen that renders those as R0
 * is not incomplete, it is WRONG — it says "you earned nothing from
 * subscriptions", when the truth is "nothing is tracking subscriptions". The
 * first is a business fact and the second is a build state, and a zero cannot
 * tell them apart.
 *
 * So `notTracked` is returned beside the totals and the UI renders it as
 * absence. The same rule the data layer already follows for an empty venture,
 * carried up to the screen.
 */

/**
 * Lines a complete P&L will have, that nothing writes yet. Each names the
 * milestone that fills it, so the screen can say WHY rather than just that
 * the number is missing.
 */
const NOT_TRACKED = [
  {
    key: "invoiced",
    label: "Invoiced revenue",
    reason: "The invoice engine is M5. Only manually recorded income is counted.",
  },
  {
    key: "subscriptions",
    label: "Subscription revenue",
    reason: "Recurring billing is M5.",
  },
  {
    key: "commissions",
    label: "Agent commissions",
    reason: "Commission accrual and payout runs are M5.",
  },
] as const;

// Revenue classification lives in lib/ledger.ts, beside the ledger writer.

export const pnl = platformQuery({
  args: {
    ventureId: v.optional(v.id("ventures")),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, { ventureId, since, until }) => {
    const inWindow = (at: number) =>
      (since === undefined || at >= since) && (until === undefined || at <= until);

    const ventures = (await ctx.db.query("ventures").collect())
      .filter((venture) => (ventureId ? venture._id === ventureId : true))
      .sort(byOrderThenName);

    const allLedger = await ctx.db.query("ledgerEntries").collect();
    const allExpenses = await ctx.db.query("expenses").collect();

    const perVenture = ventures.map((venture) => {
      const income = allLedger.filter(
        (row) =>
          row.ventureId === venture._id &&
          isRevenue(row.type) &&
          inWindow(row.occurredAt),
      );
      const expenses = allExpenses.filter(
        (row) => row.ventureId === venture._id && inWindow(row.incurredAt),
      );

      /*
       * A currency appears if EITHER side has activity in it. Deriving the
       * list from income alone would hide a venture that only spent, which is
       * the normal state of a venture in its first month.
       */
      const currencies = [
        ...new Set([...income.map((r) => r.currency), ...expenses.map((r) => r.currency)]),
      ].sort() as Currency[];

      return {
        ventureId: venture._id,
        ventureName: venture.name,
        ventureType: venture.type,
        currencies: currencies.map((code) => {
          const inc = income.filter((r) => r.currency === code);
          const exp = expenses.filter((r) => r.currency === code);
          // sumCents throws on a mixed-currency array, so a regression in the
          // filter above surfaces as an error rather than a wrong number.
          const revenueCents = sumCents(inc, code);
          const expenseCents = sumCents(exp, code);
          return {
            currency: code,
            revenueCents,
            expenseCents,
            netCents: revenueCents - expenseCents,
            incomeCount: inc.length,
            expenseCount: exp.length,
          };
        }),
      };
    });

    /*
     * Combined across ventures, still per currency. There is no single total:
     * that would need a rate, and a rate baked into a stored figure is a
     * number that silently ages.
     */
    const combinedCurrencies = [
      ...new Set(perVenture.flatMap((v) => v.currencies.map((c) => c.currency))),
    ].sort() as Currency[];

    const combined = combinedCurrencies.map((code) => {
      const rows = perVenture.flatMap((v) => v.currencies.filter((c) => c.currency === code));
      const revenueCents = rows.reduce((sum, r) => sum + r.revenueCents, 0);
      const expenseCents = rows.reduce((sum, r) => sum + r.expenseCents, 0);
      return {
        currency: code,
        revenueCents,
        expenseCents,
        netCents: revenueCents - expenseCents,
      };
    });

    return {
      period: { since: since ?? null, until: until ?? null },
      ventures: perVenture,
      combined,
      /*
       * Travels with the numbers so the screen cannot render a build state as
       * a business fact.
       */
      notTracked: NOT_TRACKED.map((line) => ({ ...line })),
    };
  },
});
