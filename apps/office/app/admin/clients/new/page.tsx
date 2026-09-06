import { fetchQuery } from "convex/nextjs";
import type { FunctionReturnType } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@cc/convex/api";
import { SignOut } from "@/components/SignOut";
import { AdminNav } from "@/components/AdminNav";
import { AddBackOffice } from "./AddBackOffice";
import s from "./new-client.module.css";

/**
 * ADD A CLIENT WHO ALREADY HAS A WEBSITE.
 *
 * `onboarding.addBackOffice` is an `ownerMutation`, so the CLI cannot
 * authenticate to it and there was no other way in. A mutation nobody can
 * call is most of the way to a mutation that does not exist -- the same state
 * the issuer was in, and the reason the first paying client could not be
 * onboarded.
 *
 * Deliberately NOT the whole onboarding story. A client won through the call
 * queue goes through `convertWonDeal`, which converts the lead and issues the
 * build invoice. This one is for a client who came direct and paid outside
 * the platform, so it touches no deal and bills nobody.
 */
export default async function NewClientPage() {
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
      console.error("[admin/clients/new] ventures.list failed", { message });
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
          <h1 className={s.pageHeading}>Add a back office</h1>
          <p className={s.hint}>
            For a client who came direct and whose website is hosted
            elsewhere. Creates the client, an enquiry form the server
            validates against, and an invite -- in one transaction. No deal is
            touched and no invoice is issued.
          </p>
        </header>

        <AddBackOffice ventures={ventures.map((v) => ({ _id: v._id, name: v.name }))} />
      </main>
    </div>
  );
}
