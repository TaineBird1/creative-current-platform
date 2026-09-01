import { fetchQuery } from "convex/nextjs";
import type { FunctionReturnType } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";
import { api } from "@cc/convex/api";
import { SignOut } from "@/components/SignOut";
import { AdminNav } from "@/components/AdminNav";
import { TaskInbox } from "./TaskInbox";
import s from "../console.module.css";

/**
 * THE INBOX.
 *
 * Read twice a day — once before the calls and once after — which is why it
 * is a list rather than one-thing-at-a-time like the queue. The queue is
 * worked standing up; this is scanned.
 */

type Ventures = FunctionReturnType<typeof api.ventures.list>;

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const token = await convexAuthNextjsToken();

  let ventures: Ventures = [];
  let expired = false;
  let refused = false;

  try {
    ventures = await fetchQuery(api.ventures.list, {}, { token });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNAUTHENTICATED|AuthProvider|Unauthorized|token/i.test(message)) {
      expired = true;
    } else if (/FORBIDDEN/.test(message)) {
      refused = true;
    } else {
      console.error("[admin] tasks load failed", { message });
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

        <main className={s.page}>
          {expired || refused ? (
            <>
              <h1 className={s.h1}>{expired ? "Your session has expired" : "Not found"}</h1>
              <p className={s.lede}>
                {expired
                  ? "Sign out and sign in again."
                  : "This account is not part of the platform team."}
              </p>
            </>
          ) : (
            <>
              {/* No eyebrow above the heading — the console's rule. */}
              <h1 className={s.h1}>Inbox</h1>
              <TaskInbox
                ventures={ventures.map((venture) => ({ _id: venture._id, name: venture.name }))}
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export const metadata = { title: "Inbox" };
