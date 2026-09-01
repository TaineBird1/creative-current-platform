import { fetchQuery } from "convex/nextjs";
import type { FunctionReturnType } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";
import { api } from "@cc/convex/api";
import type { Id } from "@cc/convex/dataModel";
import { SignOut } from "@/components/SignOut";
import { AdminNav } from "@/components/AdminNav";
import { NewExternalClient } from "./NewExternalClient";
import { DemoData } from "./DemoData";
import s from "./console.module.css";

/**
 * THE OWNER'S CONSOLE (M3.5 slice).
 *
 * The portfolio layer: every venture the owner runs, and every client under
 * them — platform tenants and external consulting clients side by side, in
 * one list, which is the entire point of the venture dimension. "What is each
 * thing actually making me" starts with being able to see them together.
 *
 * It asks Convex who the caller is rather than trusting the session cookie.
 * A session proves someone signed in; it says nothing about whether they are
 * platform staff, and every client owner in the system holds one. The
 * middleware cannot make that distinction — it only sees that a token exists.
 *
 * Monochrome throughout. No client colour reaches this world.
 */

type Ventures = FunctionReturnType<typeof api.ventures.list>;
type Clients = FunctionReturnType<typeof api.clients.list>;

/** Signed in, but not platform staff — or the session lapsed mid-session. */
function Refused({ expired }: { expired: boolean }) {
  return (
    <div className="world-admin">
      <div className={s.shell}>
        <header className={s.topbar}>
          <p className={s.brand}>The Creative Current</p>
          <AdminNav />
          <div className={s.who}>
            <SignOut />
          </div>
        </header>
        <main className={s.page}>
          <h1 className={s.h1}>{expired ? "Your session has expired" : "Not found"}</h1>
          <p className={s.lede}>
            {expired
              ? "Sign out and sign in again."
              : "This account is not part of the platform team. If you manage a business here, your back office is at /c/<your-slug>."}
          </p>
        </main>
      </div>
    </div>
  );
}

export default async function Console({
  searchParams,
}: {
  searchParams: Promise<{ venture?: string }>;
}) {
  const token = await convexAuthNextjsToken();
  const { venture: ventureParam } = await searchParams;

  let role: string | null = null;
  let ventures: Ventures = [];
  let clients: Clients = [];
  let expired = false;

  try {
    role = (await fetchQuery(api.platform.me, {}, { token })).role;
    ventures = await fetchQuery(api.ventures.list, {}, { token });

    /*
     * The lens is validated against what actually exists rather than passed
     * through. A stale bookmark pointing at an archived venture should show
     * the whole portfolio, not an empty screen the owner has to diagnose.
     */
    const selected = ventures.find((v) => v._id === ventureParam)?._id ?? undefined;
    clients = await fetchQuery(
      api.clients.list,
      selected ? { ventureId: selected as Id<"ventures"> } : {},
      { token },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNAUTHENTICATED|AuthProvider|Unauthorized|token/i.test(message)) {
      expired = true;
    } else if (!/FORBIDDEN/.test(message)) {
      console.error("[admin] console load failed", { message });
      throw error;
    }
  }

  if (role === null) return <Refused expired={expired} />;

  const current = ventures.find((v) => v._id === ventureParam);
  const totalClients = ventures.reduce((sum, v) => sum + v.clientCount, 0);

  return (
    <div className="world-admin">
      <div className={s.shell}>
        <header className={s.topbar}>
          <p className={s.brand}>The Creative Current</p>
          <div className={s.who}>
            <span className={s.role}>{role}</span>
            <SignOut />
          </div>
        </header>

        <main className={s.page}>
          <h1 className={s.h1}>Console</h1>
          <p className={s.lede}>
            Every venture and every client in one place — platform tenants and
            external work side by side.
          </p>

          {ventures.length === 0 ? (
            <div className={s.empty}>
              <p className={s.emptyTitle}>No ventures yet</p>
              <p className={s.emptyBody}>
                A venture is how the portfolio splits: the platform business,
                consulting, property. Every client, invoice and expense carries
                one, which is what makes a per-venture P&amp;L possible. The
                first is created from the CLI with{" "}
                <code>ventures:create</code> until the form lands here.
              </p>
            </div>
          ) : (
            <>
              <nav className={s.switcher} aria-label="Filter by venture">
                <Link
                  href="/admin"
                  className={s.switchLink}
                  aria-current={current ? undefined : "page"}
                >
                  All
                  <span className={s.count}>{totalClients}</span>
                </Link>
                {ventures.map((v) => (
                  <Link
                    key={v._id}
                    href={`/admin?venture=${v._id}`}
                    className={s.switchLink}
                    aria-current={current?._id === v._id ? "page" : undefined}
                  >
                    {v.name}
                    <span className={s.count}>{v.clientCount}</span>
                  </Link>
                ))}
              </nav>

              <section className={s.section}>
                <div className={s.sectionHead}>
                  <h2 className={s.h2}>
                    {current ? `${current.name} clients` : "All clients"}
                  </h2>
                  <p className={s.hint}>
                    {clients.length} {clients.length === 1 ? "client" : "clients"}
                  </p>
                </div>

                {clients.length === 0 ? (
                  <div className={s.empty}>
                    <p className={s.emptyTitle}>
                      {current ? `Nothing under ${current.name} yet` : "No clients yet"}
                    </p>
                    <p className={s.emptyBody}>
                      A platform client arrives through onboarding and gets a
                      site and a back office. An external client is consulting
                      or side work — invoices and tasks through the same ledger,
                      but no site and no portal. Add one below.
                    </p>
                  </div>
                ) : (
                  <div className={s.tableWrap}>
                    <table className={s.table}>
                      <thead>
                        <tr>
                          <th className={s.th} scope="col">Client</th>
                          <th className={s.th} scope="col">Kind</th>
                          <th className={s.th} scope="col">Venture</th>
                          <th className={s.th} scope="col">Status</th>
                          <th className={s.th} scope="col">Domain</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clients.map((c) => (
                          <tr key={c._id} className={s.row}>
                            <td className={`${s.td} ${s.name}`}>
                              {c.name}
                              {c.isDemo ? <> <span className={s.badge}>demo</span></> : null}
                              {c.isSeed ? <> <span className={s.badge}>seed</span></> : null}
                            </td>
                            <td className={s.td}>
                              <span
                                className={
                                  c.kind === "platform" ? `${s.badge} ${s.badgeStrong}` : s.badge
                                }
                              >
                                {c.kind}
                              </span>
                            </td>
                            <td className={`${s.td} ${s.muted}`}>{c.ventureName ?? "—"}</td>
                            <td className={`${s.td} ${s.muted}`}>{c.status}</td>
                            <td className={`${s.td} ${s.muted} ${s.mono}`}>
                              {/*
                                * An external client has no domain and never
                                * will. An em dash says "not applicable"; a
                                * blank cell reads as "we do not know".
                                */}
                              {c.kind === "external"
                                ? "—"
                                : (c.liveDomain ?? (c.slug ? `/${c.slug}` : "—"))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className={s.section}>
                <NewExternalClient
                  ventures={ventures.map((v) => ({
                    _id: v._id,
                    name: v.name,
                    currency: v.currency,
                  }))}
                  isOwner={role === "owner"}
                />
              </section>

              {/* Renders nothing unless the backend allows seeding. */}
              <section className={s.section}>
                <DemoData />
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
