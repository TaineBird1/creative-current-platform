import { fetchQuery } from "convex/nextjs";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { api } from "@cc/convex/api";
import { accentStyle } from "@/lib/accent-css";
import { QuoteBuilder } from "./QuoteBuilder";
import s from "../back-office.module.css";

/**
 * QUOTES, in the client's own back office.
 *
 * The loop this closes: a request arrives from their website, they price it,
 * and the customer gets a link that can be accepted. Every part of that
 * existed in `convex/quotes.ts` and none of it had a screen, so in practice a
 * client saw the request and answered it over WhatsApp by hand — the backend
 * was complete and the product was not.
 *
 * There is no clientId anywhere in this file. The slug names the tenant and
 * the server re-derives it from the signed-in user's own memberships, so a
 * forged slug reaches nothing.
 */
export default async function QuotesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const token = await convexAuthNextjsToken();

  let quotes: FunctionReturnType<typeof api.quotes.list> | null = null;
  let requests: FunctionReturnType<typeof api.quoteRequests.list> | null = null;
  let brand: FunctionReturnType<typeof api.clients.brand> | null = null;
  let denied = false;

  try {
    /*
     * In parallel, and a failure in any of them reaches the same handling
     * rather than one quietly rendering empty — an empty quote list and a
     * refused query look identical on screen and mean opposite things.
     */
    [quotes, requests, brand] = await Promise.all([
      fetchQuery(api.quotes.list, { clientSlug: slug }, { token }),
      fetchQuery(api.quoteRequests.list, { clientSlug: slug }, { token }),
      fetchQuery(api.clients.brand, { clientSlug: slug }, { token }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/NOT_FOUND|FORBIDDEN|UNAUTHENTICATED|token/i.test(message)) {
      // A real answer: this tenant is not yours. Indistinguishable from an
      // unknown slug, by design.
      denied = true;
    } else {
      throw error;
    }
  }

  if (denied || !quotes || !requests) {
    return (
      <main className={`world-client ${s.main}`}>
        <div className={s.emptyState}>
          <h1 className={s.heading}>Not found</h1>
          <p className={s.body}>
            This back office is not one you have access to.{" "}
            <Link href={`/c/${slug}/sign-in`}>Sign in</Link> if you have not.
          </p>
        </div>
      </main>
    );
  }

  return (
    <div
      className="world-client"
      style={brand?.accent ? accentStyle(brand.accent) : undefined}
    >
      <header className={s.bar}>
        <div>
          <h1 className={s.heading}>Quotes</h1>
          <p className={s.today}>{brand?.name ?? "Your business"}</p>
        </div>
        <Link className={s.today} href={`/c/${slug}`}>
          Back to today
        </Link>
      </header>

      <main className={s.main}>
        <QuoteBuilder
          quotes={quotes}
          requests={requests}
          currency={brand?.currency ?? "ZAR"}
        />
      </main>
    </div>
  );
}
