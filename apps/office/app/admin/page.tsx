import { fetchQuery } from "convex/nextjs";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { api } from "@cc/convex/api";
import { SignOut } from "@/components/SignOut";
import s from "./admin.module.css";

/**
 * The owner console at its M1 size. Lead engine, pipeline, fleet and finance
 * are M4+; this exists so /admin is not a 404 behind the sign-in.
 *
 * It asks Convex who the caller is rather than trusting the session cookie.
 * A session proves someone signed in; it says nothing about whether they are
 * platform staff, and every client owner in the system holds one. The
 * middleware cannot make that distinction — it only sees that a token exists.
 *
 * Monochrome throughout. No client colour reaches this world.
 */
export default async function Admin() {
  const token = await convexAuthNextjsToken();

  let role: string | null = null;
  let expired = false;

  try {
    role = (await fetchQuery(api.platform.me, {}, { token })).role;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNAUTHENTICATED|AuthProvider|Unauthorized|token/i.test(message)) {
      expired = true;
    } else if (!/FORBIDDEN/.test(message)) {
      console.error("[admin] platform.me failed", { message });
      throw error;
    }
    // FORBIDDEN falls through with role === null: signed in, not platform staff.
  }

  if (role === null) {
    return (
      <div className="world-admin">
        <main className={s.wrap}>
          <div className={s.panel}>
            <h1 className={s.heading}>
              {expired ? "Your session has expired." : "Not found"}
            </h1>
            <p className={s.body}>
              {expired
                ? "Sign out and sign in again."
                : "This account is not part of the platform team. If you manage a business here, your back office is at /c/<your-slug>."}
            </p>
            <div className={s.actions}>
              <SignOut />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="world-admin">
      <main className={s.wrap}>
        <div className={s.panel}>
          <p className={s.eyebrow}>The Creative Current · {role}</p>
          <h1 className={s.heading}>Admin</h1>
          <p className={s.body}>
            Signed in. The console itself is M4 — lead engine, pipeline, fleet
            and finance. Client back offices are at <code>/c/&lt;slug&gt;</code>.
          </p>
          <div className={s.actions}>
            <SignOut />
          </div>
        </div>
      </main>
    </div>
  );
}
