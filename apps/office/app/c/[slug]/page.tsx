import { fetchQuery } from "convex/nextjs";
import type { QuoteRequestRow } from "@cc/convex-src/quoteRequests";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@cc/convex/api";
import { accentStyle } from "@/lib/accent-css";
import { SignOut } from "@/components/SignOut";
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

  const brand = await fetchQuery(api.public.brand.forSignIn, { slug }).catch(() => null);

  // A blanket `.catch(() => null)` here conflates two completely different
  // things: "you have no access" (correct, expected, shows Not found) and
  // "the request never happened" (a bug, and one that looks identical to the
  // user). Separate them, and let anything unrecognised reach the server log.
  // FunctionReturnType, not Awaited<ReturnType<typeof fetchQuery<...>>> — the
  // latter resolves loosely and silently gives up type safety on every row.
  let requests: QuoteRequestRow[] | null = null;
  let denied = false;
  let expired = false;

  try {
    requests = await fetchQuery(api.quoteRequests.list, { clientSlug: slug }, { token });
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
  if (denied || requests === null) {
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
      <header className={s.bar}>
        <div>
          <p className={s.eyebrow}>{brand?.name ?? slug}</p>
          <h1 className={s.heading}>Quote requests</h1>
        </div>
        <SignOut />
      </header>

      <main className={s.main}>
        {requests.length === 0 ? (
          <div className={s.emptyState}>
            <h2 className={s.subheading}>Nothing yet.</h2>
            <p className={s.body}>
              Requests from your website land here the moment someone sends one.
            </p>
          </div>
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
