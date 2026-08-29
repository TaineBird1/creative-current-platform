import { fetchQuery } from "convex/nextjs";
import type { FunctionReturnType } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@cc/convex/api";
import { SignOut } from "@/components/SignOut";
import { ClientPicker } from "./ClientPicker";
import s from "./domains.module.css";

/**
 * Domains, platform-side. The console asks Convex who the caller is rather
 * than trusting the session cookie — every client owner holds one of those.
 */
export default async function DomainsPage() {
  const token = await convexAuthNextjsToken();

  let clients: FunctionReturnType<typeof api.clients.list> | null = null;
  let refused = false;

  try {
    clients = await fetchQuery(api.clients.list, {}, { token });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNAUTHENTICATED|FORBIDDEN|AuthProvider|token/i.test(message)) {
      refused = true;
    } else {
      console.error("[admin/domains] clients.list failed", { message });
      throw error;
    }
  }

  if (refused || clients === null) {
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
      <main className={s.page}>
        <header className={s.pageHead}>
          <div>
            <p className={s.eyebrow}>The Creative Current</p>
            <h1 className={s.pageHeading}>Domains</h1>
          </div>
          <SignOut />
        </header>
        <ClientPicker clients={clients} />
      </main>
    </div>
  );
}
