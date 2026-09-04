import { fetchQuery } from "convex/nextjs";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { api } from "@cc/convex/api";
import { accentStyle } from "@/lib/accent-css";
import { Outbox } from "./Outbox";
import s from "../back-office.module.css";

/**
 * THE OUTBOX, in the client's own back office.
 *
 * `messages.outbox` has existed and had no screen, which meant the question it
 * answers — "did my customer actually hear from us" — was answerable only by
 * somebody at a terminal running a Convex command. In practice that is a phone
 * call to the agency about a customer the agency has never met.
 *
 * No clientId anywhere in this file: the slug names the tenant and the server
 * re-derives it from the signed-in user's own memberships.
 */
export default async function MessagesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const token = await convexAuthNextjsToken();

  let rows: FunctionReturnType<typeof api.messages.outbox> | null = null;
  let brand: FunctionReturnType<typeof api.clients.brand> | null = null;
  let bookings: FunctionReturnType<typeof api.bookings.upcoming> | null = null;
  let denied = false;

  try {
    /*
     * `bookings.upcoming` is here only for its `timezone` — every time on this
     * screen is rendered in the CLIENT's zone rather than the browser's, and
     * the query is the thing that knows it. A screen that quietly renders in
     * the phone's zone is wrong for exactly the client who travels.
     */
    [rows, brand, bookings] = await Promise.all([
      fetchQuery(api.messages.outbox, { clientSlug: slug }, { token }),
      fetchQuery(api.clients.brand, { clientSlug: slug }, { token }),
      fetchQuery(api.bookings.upcoming, { clientSlug: slug }, { token }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/NOT_FOUND|FORBIDDEN|UNAUTHENTICATED|token/i.test(message)) {
      // A real answer: this tenant is not yours, and it is indistinguishable
      // from an unknown slug by design.
      denied = true;
    } else {
      throw error;
    }
  }

  if (denied || !rows) {
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
          <h1 className={s.heading}>Messages</h1>
          <p className={s.today}>{brand?.name ?? "Your business"}</p>
        </div>
        <Link className={s.today} href={`/c/${slug}`}>
          Back to today
        </Link>
      </header>

      <main className={s.main}>
        <Outbox rows={rows} timezone={bookings?.timezone ?? "Africa/Johannesburg"} />
      </main>
    </div>
  );
}
