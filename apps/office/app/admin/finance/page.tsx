import { fetchQuery } from "convex/nextjs";
import type { FunctionReturnType } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";
import { api } from "@cc/convex/api";
import { formatCents } from "@cc/convex-src/lib/money";
import { SignOut } from "@/components/SignOut";
import { RecordEntry } from "./RecordEntry";
import c from "../console.module.css";
import s from "./finance.module.css";

/**
 * PER-VENTURE P&L (Part 5.4).
 *
 * The question the portfolio layer exists to answer: what is each thing
 * actually making me. Revenue minus expenses, per venture, per currency, for
 * a month.
 *
 * Two rules this screen will not break:
 *
 * 1. NEVER a single total across currencies. That needs a rate, and a rate
 *    baked into a printed figure is a number that silently ages.
 * 2. NEVER a zero for something unbuilt. Invoiced revenue, subscriptions and
 *    commissions are M5. Rendering them as R0.00 would say "you earned
 *    nothing from subscriptions" when the truth is "nothing tracks
 *    subscriptions yet" — a business fact and a build state, and a zero
 *    cannot tell them apart. They render as an em dash and a reason.
 */

type Pnl = FunctionReturnType<typeof api.finance.pnl>;

/** `2026-08` → the UTC millisecond bounds of that month. */
function monthBounds(month: string): { since: number; until: number; label: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11) return null;
  const since = Date.UTC(year, index, 1);
  // Last millisecond of the month, so an entry stamped 23:59 on the 31st is in.
  const until = Date.UTC(year, index + 1, 1) - 1;
  const label = new Date(since).toLocaleDateString("en-ZA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { since, until, label };
}

const shiftMonth = (month: string, by: number) => {
  const [year, index] = month.split("-").map(Number);
  const d = new Date(Date.UTC(year!, index! - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

const thisMonth = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
};

export default async function Finance({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; all?: string }>;
}) {
  const token = await convexAuthNextjsToken();
  const { month: monthParam, all } = await searchParams;

  const allTime = all === "1";
  const month = monthBounds(monthParam ?? "") ? monthParam! : thisMonth();
  const bounds = monthBounds(month)!;

  let pnl: Pnl | null = null;
  let ventures: FunctionReturnType<typeof api.ventures.list> = [];
  let role: string | null = null;
  let expired = false;

  try {
    role = (await fetchQuery(api.platform.me, {}, { token })).role;
    ventures = await fetchQuery(api.ventures.list, {}, { token });
    pnl = await fetchQuery(
      api.finance.pnl,
      allTime ? {} : { since: bounds.since, until: bounds.until },
      { token },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNAUTHENTICATED|AuthProvider|Unauthorized|token/i.test(message)) {
      expired = true;
    } else if (!/FORBIDDEN/.test(message)) {
      console.error("[admin/finance] load failed", { message });
      throw error;
    }
  }

  if (role === null || pnl === null) {
    return (
      <div className="world-admin">
        <div className={c.shell}>
          <header className={c.topbar}>
            <p className={c.brand}>The Creative Current</p>
            <div className={c.who}>
              <SignOut />
            </div>
          </header>
          <main className={c.page}>
            <h1 className={c.h1}>{expired ? "Your session has expired" : "Not found"}</h1>
            <p className={c.lede}>
              {expired
                ? "Sign out and sign in again."
                : "This account is not part of the platform team."}
            </p>
          </main>
        </div>
      </div>
    );
  }

  const withActivity = pnl.ventures.filter((v) => v.currencies.length > 0);

  return (
    <div className="world-admin">
      <div className={c.shell}>
        <header className={c.topbar}>
          <p className={c.brand}>The Creative Current</p>
          <div className={c.who}>
            <span className={c.role}>{role}</span>
            <SignOut />
          </div>
        </header>

        <main className={c.page}>
          <h1 className={c.h1}>Finance</h1>
          <p className={c.lede}>
            What each venture is making, per currency. <Link href="/admin">Console</Link>
          </p>

          <div className={s.period}>
            <Link
              className={s.periodNav}
              href={`/admin/finance?month=${shiftMonth(month, -1)}`}
              aria-label="Previous month"
            >
              ‹
            </Link>
            <span className={s.periodLabel}>{allTime ? "All time" : bounds.label}</span>
            <Link
              className={s.periodNav}
              href={`/admin/finance?month=${shiftMonth(month, 1)}`}
              aria-label="Next month"
            >
              ›
            </Link>
            <Link
              className={s.periodAll}
              href={`/admin/finance?month=${month}`}
              aria-current={allTime ? undefined : "page"}
            >
              Month
            </Link>
            <Link
              className={s.periodAll}
              href="/admin/finance?all=1"
              aria-current={allTime ? "page" : undefined}
            >
              All time
            </Link>
          </div>

          {withActivity.length === 0 ? (
            <div className={c.empty}>
              <p className={c.emptyTitle}>
                Nothing recorded {allTime ? "yet" : `in ${bounds.label}`}
              </p>
              <p className={c.emptyBody}>
                This is an absence of records, not a month where nothing
                happened. Record what came in and what went out below, and the
                net becomes real.
              </p>
            </div>
          ) : (
            <>
              {withActivity.map((venture) => (
                <section key={venture.ventureId} className={s.ventureBlock}>
                  <h2 className={s.ventureName}>{venture.ventureName}</h2>
                  <p className={s.ventureMeta}>{venture.ventureType}</p>

                  {venture.currencies.map((row) => (
                    <div key={row.currency} className={s.statement}>
                      <p className={s.currencyTag}>{row.currency}</p>

                      <span className={s.lineLabel}>
                        Revenue <span className={s.count}>{row.incomeCount}</span>
                      </span>
                      <span className={s.lineValue}>
                        {formatCents(row.revenueCents, row.currency)}
                      </span>

                      <span className={s.lineLabel}>
                        Expenses <span className={s.count}>{row.expenseCount}</span>
                      </span>
                      <span className={s.lineValue}>
                        −{formatCents(row.expenseCents, row.currency)}
                      </span>

                      <span className={`${s.lineLabel} ${s.netLabel} ${s.netRow}`}>Net</span>
                      <span
                        className={`${s.lineValue} ${s.netValue} ${s.netRow} ${
                          row.netCents < 0 ? s.negative : ""
                        }`}
                      >
                        {formatCents(row.netCents, row.currency)}
                      </span>
                    </div>
                  ))}
                </section>
              ))}

              {pnl.combined.length > 0 ? (
                <section className={s.ventureBlock}>
                  <h2 className={s.ventureName}>All ventures</h2>
                  <p className={s.ventureMeta}>
                    Combined across ventures — still one statement per currency, never one total
                  </p>
                  {pnl.combined.map((row) => (
                    <div key={row.currency} className={s.statement}>
                      <p className={s.currencyTag}>{row.currency}</p>
                      <span className={s.lineLabel}>Revenue</span>
                      <span className={s.lineValue}>
                        {formatCents(row.revenueCents, row.currency)}
                      </span>
                      <span className={s.lineLabel}>Expenses</span>
                      <span className={s.lineValue}>
                        −{formatCents(row.expenseCents, row.currency)}
                      </span>
                      <span className={`${s.lineLabel} ${s.netLabel} ${s.netRow}`}>Net</span>
                      <span
                        className={`${s.lineValue} ${s.netValue} ${s.netRow} ${
                          row.netCents < 0 ? s.negative : ""
                        }`}
                      >
                        {formatCents(row.netCents, row.currency)}
                      </span>
                    </div>
                  ))}
                </section>
              ) : null}
            </>
          )}

          <section className={s.notTracked}>
            <h2 className={s.notTrackedTitle}>Not tracked yet</h2>
            <p className={s.notTrackedIntro}>
              These lines belong in a complete P&amp;L and nothing writes them
              yet. They are shown as absent rather than as zero, because a zero
              would claim you earned nothing from them — which is a different
              statement from “this is not being measured”.
            </p>
            <ul className={s.notTrackedList}>
              {pnl.notTracked.map((line) => (
                <li key={line.key} className={s.notTrackedRow}>
                  <span className={s.notTrackedLabel}>
                    {line.label} <span className={s.notTrackedDash}>—</span>
                  </span>
                  <span className={s.notTrackedReason}>{line.reason}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={c.section}>
            <RecordEntry
              ventures={ventures.map((v) => ({
                _id: v._id,
                name: v.name,
                currency: v.currency,
              }))}
              isOwner={role === "owner"}
              defaultDate={new Date(allTime ? Date.now() : bounds.since)
                .toISOString()
                .slice(0, 10)}
            />
          </section>
        </main>
      </div>
    </div>
  );
}
