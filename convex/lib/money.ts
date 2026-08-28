import { ConvexError } from "convex/values";

/**
 * THE MONEY CHOKE POINT.
 *
 * Amounts are integer cents in a plain `number`. That is exact in float64 up
 * to 2^53 (~R90 trillion) and survives JSON.stringify, which bigint does not
 * -- and every webhook payload, invoice PDF and accountant CSV is a
 * stringify. What float64 does NOT give us for free is integer-ness: a stray
 * `/ 3`, a parsed "12.5", a percentage applied without rounding.
 *
 * So integer-ness is asserted here, at the one place every financial write
 * passes through, rather than trusted to a type. Call assertCents on anything
 * heading for invoices, payments, ledgerEntries, expenses or commissions.
 */

export type Currency = "ZAR" | "USD" | "EUR" | "GBP" | "NAD" | "BWP";

/** ~R90tn. Anything larger is a unit mistake (rands passed as cents, or worse). */
const MAX_CENTS = Number.MAX_SAFE_INTEGER;

export function assertCents(value: number, field = "amountCents"): number {
  if (!Number.isFinite(value)) {
    throw new ConvexError({ code: "BAD_MONEY", message: `${field} is not finite` });
  }
  if (!Number.isInteger(value)) {
    throw new ConvexError({
      code: "BAD_MONEY",
      message: `${field} must be whole cents, got ${value}`,
    });
  }
  if (Math.abs(value) > MAX_CENTS) {
    throw new ConvexError({
      code: "BAD_MONEY",
      message: `${field} exceeds safe integer range`,
    });
  }
  return value;
}

/** Every money-carrying object handed to the database goes through this. */
export function assertMoney<T extends Record<string, unknown>>(
  doc: T,
  fields: readonly (keyof T & string)[],
): T {
  for (const f of fields) {
    const value = doc[f];
    if (value === undefined) continue;
    assertCents(value as number, f);
  }
  return doc;
}

/**
 * Multiply cents by a quantity or a rate and land back on whole cents.
 * Rounds half away from zero -- the convention every SA invoice uses, and the
 * one an accountant will re-derive by hand.
 */
export function scaleCents(cents: number, factor: number): number {
  assertCents(cents, "cents");
  if (!Number.isFinite(factor)) {
    throw new ConvexError({ code: "BAD_MONEY", message: "factor is not finite" });
  }
  const raw = cents * factor;
  const rounded = raw < 0 ? -Math.round(-raw) : Math.round(raw);
  return assertCents(rounded, "scaled");
}

/**
 * Sum within ONE currency. There is deliberately no function that sums across
 * currencies -- the shape of this signature is the enforcement.
 */
export function sumCents(
  entries: readonly { amountCents: number; currency: Currency }[],
  currency: Currency,
): number {
  let total = 0;
  for (const e of entries) {
    if (e.currency !== currency) {
      throw new ConvexError({
        code: "CURRENCY_MISMATCH",
        message: `refusing to sum ${e.currency} into a ${currency} total`,
      });
    }
    total += assertCents(e.amountCents);
  }
  return assertCents(total, "total");
}

/** Display only. Never round-trips back into a stored amount. */
export function formatCents(cents: number, currency: Currency, locale = "en-ZA"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
