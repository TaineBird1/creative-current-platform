import { fetchQuery } from "convex/nextjs";
import type { FunctionReturnType } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@cc/convex/api";
import { SignOut } from "@/components/SignOut";
import { AdminNav } from "@/components/AdminNav";
import { ImportLeads } from "./ImportLeads";
import s from "./import.module.css";

/**
 * BRING A LIST IN.
 *
 * The call queue, the suppression list and the demo builder all work.
 * Production had no leads in it, and the only way in was an internalMutation
 * run from a terminal with a hand-written JSON payload -- a documented
 * command, which this repo has twice learned the cost of.
 */
export default async function ImportLeadsPage() {
  const token = await convexAuthNextjsToken();

  let ventures: FunctionReturnType<typeof api.ventures.list> | null = null;
  let refused = false;

  try {
    ventures = await fetchQuery(api.ventures.list, {}, { token });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNAUTHENTICATED|FORBIDDEN|AuthProvider|token/i.test(message)) {
      refused = true;
    } else {
      console.error("[admin/leads/import] ventures.list failed", { message });
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

  return (
    <div className="world-admin">
      <AdminNav />
      <main className={s.page}>
        <header className={s.pageHead}>
          <h1 className={s.pageHeading}>Import leads</h1>
          <p className={s.hint}>
            Paste a list from a directory. Every row carries where it came
            from, recorded at capture and never editable afterwards.
          </p>
        </header>

        <ImportLeads ventures={ventures.map((v) => ({ _id: v._id, name: v.name }))} />
      </main>
    </div>
  );
}
