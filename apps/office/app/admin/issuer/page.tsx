import Link from "next/link";
import { fetchQuery } from "convex/nextjs";
import type { FunctionReturnType } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@cc/convex/api";
import type { Id } from "@cc/convex/dataModel";
import { SignOut } from "@/components/SignOut";
import { AdminNav } from "@/components/AdminNav";
import { IssuerForm, type IssuerRow } from "./IssuerForm";
import s from "./issuer.module.css";

/**
 * WHO ISSUES THE INVOICES — the screen that had to exist first.
 *
 * `issuer.set` and `issuer.confirm` are `ownerMutation`s, so they need an
 * authenticated owner. `npx convex run` is unauthenticated, which meant there
 * was no way to reach them at all: not from the CLI, not from a script, and
 * not from any screen, because there wasn't one. And `convertWonDeal` checks
 * for a CONFIRMED issuer before it writes anything — so onboarding the first
 * paying client refused, from a state nobody could get out of.
 *
 * Per VENTURE, because one person can trade as a sole prop for consulting and
 * form a company for the sites business, and on that day only one venture's
 * issuer changes while every invoice already sent keeps its snapshot.
 */
export default async function IssuerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const token = await convexAuthNextjsToken();
  const params = await searchParams;

  let ventures: FunctionReturnType<typeof api.ventures.list> | null = null;
  let refused = false;

  try {
    ventures = await fetchQuery(api.ventures.list, {}, { token });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNAUTHENTICATED|FORBIDDEN|AuthProvider|token/i.test(message)) {
      refused = true;
    } else {
      console.error("[admin/issuer] ventures.list failed", { message });
      throw error;
    }
  }

  if (refused || ventures === null) {
    return (
      <div className="world-admin">
        <main className={s.page}>
          <h1 className={s.pageHeading}>Not found</h1>
          <p className={s.hint}>This account is not part of the platform team.</p>
          <div className={s.actions}>
            <SignOut />
          </div>
        </main>
      </div>
    );
  }

  /*
   * Destructured rather than length-checked, so the same test that reports
   * "no ventures" is the one that narrows the type. A `length === 0` guard
   * reads as equivalent and does not narrow an index access.
   */
  const [firstVenture] = ventures;

  if (!firstVenture) {
    return (
      <div className="world-admin">
        <AdminNav />
        <main className={s.page}>
          <h1 className={s.pageHeading}>Who issues the invoices</h1>
          <p className={s.hint}>
            There are no ventures yet. An issuer belongs to one, so create a
            venture first.
          </p>
        </main>
      </div>
    );
  }

  const wanted = typeof params.venture === "string" ? params.venture : null;
  const selected =
    ventures.find((venture) => venture._id === wanted) ?? firstVenture;

  const issuer = await fetchQuery(
    api.issuer.get,
    { ventureId: selected._id as Id<"ventures"> },
    { token },
  );

  const state = !issuer
    ? "blocked"
    : issuer.confirmed
      ? "ready"
      : "pending";

  return (
    <div className="world-admin">
      <AdminNav />
      <main className={s.page}>
        <header className={s.pageHead}>
          <h1 className={s.pageHeading}>Who issues the invoices</h1>
          <p className={s.hint}>
            The legal name, address and bank details that print on every
            invoice and quote you send. Set once per venture.
          </p>
        </header>

        {/*
          THE STATE, FIRST AND IN FULL WIDTH. Whether anything can be invoiced
          is the reason to open this screen, and a chip beside the heading
          reads as decoration rather than as the finding.
        */}
        <section className={s.state} data-tone={state}>
          <h2 className={s.stateHeading}>
            {state === "ready"
              ? "Confirmed — invoices can be issued"
              : state === "pending"
                ? "Set, but not confirmed"
                : "Nothing can be invoiced yet"}
          </h2>
          <p className={s.stateBody}>
            {state === "ready" ? (
              <>
                Confirmed{" "}
                {issuer?.confirmedAt
                  ? new Date(issuer.confirmedAt).toLocaleDateString("en-ZA", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                      timeZone: "Africa/Johannesburg",
                    })
                  : null}
                . Onboarding a client and issuing an invoice will both go
                through. Editing anything below clears this.
              </>
            ) : state === "pending" ? (
              <>
                The details are stored and every invoice still refuses.
                Confirmation is a separate act on purpose — it is the only
                check that can tell a real legal name from a plausible
                invented one, and it needs a person.
              </>
            ) : (
              <>
                Issuing an invoice refuses, and so does onboarding a client —
                <code> convertWonDeal</code> checks for a confirmed issuer
                before it writes anything, so that an admin detail fails the
                whole transaction rather than half of it.
              </>
            )}
          </p>
        </section>

        {/*
          Always rendered, even with a single venture. Which venture is being
          edited is then something you read rather than remember — and the
          per-venture state is the information, so it sits on the control.
        */}
        <ul className={s.ventures}>
          {ventures.map((venture) => (
            <li key={venture._id}>
              <Link
                className={s.venture}
                href={`/admin/issuer?venture=${venture._id}`}
                aria-current={venture._id === selected._id ? "page" : undefined}
              >
                {venture.name}
              </Link>
            </li>
          ))}
        </ul>

        <IssuerForm
          ventureId={selected._id as Id<"ventures">}
          issuer={(issuer as IssuerRow) ?? null}
        />
      </main>
    </div>
  );
}
