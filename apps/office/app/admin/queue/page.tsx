import { fetchQuery } from "convex/nextjs";
import type { FunctionReturnType } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";
import { api } from "@cc/convex/api";
import { SignOut } from "@/components/SignOut";
import { AdminNav } from "@/components/AdminNav";
import { CallQueue } from "./CallQueue";
import s from "../console.module.css";
import q from "./queue.module.css";

/**
 * TODAY'S QUEUE.
 *
 * The thin version on purpose: the list, a number that dials, four buttons
 * that write back. Not Call Mode. Keyboard shortcuts, a template composer and
 * best-time learning are all guesses until twenty real calls have been made,
 * and the friction of making them is what should decide which of the three
 * gets built.
 *
 * Fetched on the server so no Convex client reaches the phone to render a
 * list, and the queue is already filtered by the time it is HTML — a
 * suppressed business is never serialised, never in the payload, never in a
 * devtools panel. See convex/lib/leadAccess.ts.
 */

type Queue = FunctionReturnType<typeof api.queue.today>;

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const token = await convexAuthNextjsToken();

  let queue: Queue = { rows: [], suppressedCount: 0, needsNumberCount: 0, listUnavailable: false };
  let expired = false;
  let refused = false;

  try {
    queue = await fetchQuery(api.queue.today, {}, { token });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNAUTHENTICATED|AuthProvider|Unauthorized|token/i.test(message)) {
      expired = true;
    } else if (/FORBIDDEN/.test(message)) {
      refused = true;
    } else {
      console.error("[admin] queue load failed", { message });
      throw error;
    }
  }

  return (
    <div className="world-admin">
      <div className={s.shell}>
        <header className={s.topbar}>
          <p className={s.brand}>
            <Link href="/admin" className={s.switchLink}>
              The Creative Current
            </Link>
          </p>
          <AdminNav />
          <div className={s.who}>
            <SignOut />
          </div>
        </header>

        <main className={q.wrap}>
          {expired || refused ? (
            <section className={q.stop}>
              <h1 className={q.stopTitle}>
                {expired ? "Your session has expired" : "Not found"}
              </h1>
              <p className={q.stopBody}>
                {expired
                  ? "Sign out and sign in again."
                  : "This account is not part of the platform team."}
              </p>
            </section>
          ) : (
            <>
              {/*
                * No eyebrow above the heading. The console's rule: a kicker is
                * a label the heading does not need, and it pushes the actual
                * title down the scan order.
                */}
              <h1 className="sr-only">Today&rsquo;s queue</h1>
              <CallQueue initial={queue} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
