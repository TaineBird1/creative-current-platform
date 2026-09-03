import { fetchQuery } from "convex/nextjs";
import type { QuoteRequestRow } from "@cc/convex-src/quoteRequests";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@cc/convex/api";
import { accentStyle } from "@/lib/accent-css";
import Link from "next/link";
import { SignOut } from "@/components/SignOut";
import { Bookings } from "./Bookings";
import type { UpcomingBookings } from "@cc/convex-src/bookings";
import s from "./back-office.module.css";

/**
 * The client back office, at its M1 size: the quote requests their own website
 * produced, and nothing else. Calendar, CRM, invoicing and the editor are M3+
 * and deliberately absent — this exists so the auth loop lands somewhere real
 * rather than on empty console chrome.
 *
 * Note there is no clientId anywhere in this file. The slug names the tenant,
 * and the server re-derives it from the signed-in user's own memberships.
 */
export default async function BackOffice({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const token = await convexAuthNextjsToken();

  /*
   * TENANT-SCOPED, not the old public brand query — which was an
   * unauthenticated slug->client oracle and is deleted. The caller here is
   * already authenticated and already has a membership, so `clients.brand`
   * answers from their own tenant and refuses everybody else.
   */
  const brand = await fetchQuery(api.clients.brand, { clientSlug: slug }, { token }).catch(
    () => null,
  );

  // A blanket `.catch(() => null)` here conflates two completely different
  // things: "you have no access" (correct, expected, shows Not found) and
  // "the request never happened" (a bug, and one that looks identical to the
  // user). Separate them, and let anything unrecognised reach the server log.
  // FunctionReturnType, not Awaited<ReturnType<typeof fetchQuery<...>>> — the
  // latter resolves loosely and silently gives up type safety on every row.
  let requests: QuoteRequestRow[] | null = null;
  let bookings: UpcomingBookings | null = null;
  let denied = false;
  let expired = false;

  try {
    /*
     * Both, in parallel. The calendar is the reason this screen exists now, so
     * it must not wait on the quote list — and a failure in either has to
     * reach the same handling below rather than one of them silently
     * rendering empty.
     */
    [requests, bookings] = await Promise.all([
      fetchQuery(api.quoteRequests.list, { clientSlug: slug }, { token }),
      fetchQuery(api.bookings.upcoming, { clientSlug: slug }, { token }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/NOT_FOUND|FORBIDDEN/.test(message)) {
      // A real answer: this tenant is not yours. Indistinguishable from an
      // unknown slug, by design.
      denied = true;
    } else if (/UNAUTHENTICATED|AuthProvider|Unauthorized|token/i.test(message)) {
      // We hold a cookie we cannot verify — an expired session, or one signed
      // with a rotated key. NOT the same as "no access", and it needs its own
      // exit, because a stale cookie is otherwise a trap: the middleware sees
      // a token and lets you through, the query refuses, and redirecting to
      // sign-in just bounces back here. Only signing out breaks the loop, so
      // that is what this state offers.
      console.warn("[back-office] unverifiable session", { slug, message });
      expired = true;
    } else {
      console.error("[back-office] quoteRequests.list failed", { slug, hasToken: Boolean(token), message });
      throw error;
    }
  }

  if (expired) {
    return (
      <div className="world-client">
        <main className={s.empty}>
          <h1 className={s.heading}>Your session has expired.</h1>
          <p className={s.body}>
            Sign out and sign in again — it takes about thirty seconds.
          </p>
          <SignOut />
        </main>
      </div>
    );
  }

  // Refusal is the correct outcome for someone with no membership on this
  // tenant, and it is indistinguishable from an unknown slug by design.
  if (denied || requests === null || bookings === null) {
    return (
      <div className="world-client">
        <main className={s.empty}>
          <h1 className={s.heading}>Not found</h1>
          <p className={s.body}>
            This back office does not exist, or your account has no access to it.
          </p>
          <SignOut />
        </main>
      </div>
    );
  }

  return (
    <div className="world-client" style={brand?.accent ? accentStyle(brand.accent) : undefined}>
      {/*
        * The business name IS the heading. It was an eyebrow over "Quote
        * requests", which stacked a kicker above a heading — banned by
        * DESIGN.md and by the craft floor — and it was also wrong now: this
        * screen is their day, and quote requests are one part of it.
        */}
      <header className={s.bar}>
        <div>
          <h1 className={s.heading}>{brand?.name ?? slug}</h1>
          <p className={s.today}>{longDate(bookings.timezone)}</p>
        </div>
        <SignOut />
      </header>

      <Bookings data={bookings} />

      <main className={s.main}>
        <div className={s.headRow}>
          <h2 className={s.subheading}>Quote requests</h2>
          {/*
            The way OUT of this list and into pricing. Without it the requests
            were a screen you could read and not act on, which is where the
            quote flow actually stopped.
          */}
          <Link className={s.headLink} href={`/c/${slug}/quotes`}>
            Price a request
          </Link>
        </div>
        {requests.length === 0 ? (
          <p className={s.body}>
            Requests from your website land here the moment someone sends one.
          </p>
        ) : (
          <ol className={s.list}>
            {requests.map((request) => (
              <li className={s.row} key={request._id}>
                <div className={s.who}>
                  <p className={s.name}>{request.name}</p>
                  {/* Staff see that work exists; the query strips contact
                      details for them, so this is null rather than hidden. */}
                  {request.phone ? (
                    <a className={`${s.phone} tabular`} href={`tel:${request.phone}`}>
                      {request.phone}
                    </a>
                  ) : (
                    <p className={s.withheld}>Contact details are owner-only</p>
                  )}
                </div>

                <dl className={s.answers}>
                  {request.answers.map((answer) => (
                    <div key={answer.key}>
                      <dt className={s.answerKey}>{humanise(answer.key)}</dt>
                      <dd className={s.answerValue}>{answer.value}</dd>
                    </div>
                  ))}
                </dl>

                <p className={`${s.when} tabular`}>
                  {new Date(request.submittedAt).toLocaleString("en-ZA", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </li>
            ))}
          </ol>
        )}
      </main>
    </div>
  );
}

/** `monthlyBill` -> `Monthly bill`. The keys are ours; the labels are theirs. */
function humanise(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Today, in the CLIENT's timezone — never the server's, and never the phone's. */
function longDate(timeZone: string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
}
