"use client";

import { useRef, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import s from "./sign-in.module.css";

/**
 * TWO STEPS: email, then the code that was emailed.
 *
 * The rules this screen is built to, in order of how often they get broken:
 *
 *   1. Never say whether an email is known. "If you have access, a code is on
 *      its way" is the only honest thing to show — anything sharper turns the
 *      form into a directory of who works at which business.
 *   2. The code step must survive the journey to an email app and back, so
 *      the email is echoed, editable, and the code can be re-sent.
 *   3. One field per step. These people are on a phone, one-handed, possibly
 *      standing on a roof.
 */
export function SignIn({
  world,
  businessName,
  accent,
  redirectTo,
}: {
  world: "admin" | "client";
  businessName?: string;
  /**
   * Applied to the .world-client element itself, never an ancestor:
   * .world-client re-declares --accent-* as neutral fallbacks, so a ramp set
   * on a parent is overridden by them and the client's colour silently
   * disappears. Nothing errors; the button just comes out grey.
   */
  accent?: React.CSSProperties;
  redirectTo: string;
}) {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  async function sendCode(event?: React.FormEvent) {
    event?.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setError("That does not look like an email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn("resend-otp", { email: email.trim() });
      setStep("code");
      // Focus after paint, so the code field is ready when they come back.
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch {
      // Deliberately vague: a distinguishable failure here tells an attacker
      // which addresses have access.
      setError("We could not send a code just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 8) {
      setError("The code is 8 digits.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn("resend-otp", { email: email.trim(), code: clean });

      // A FULL document load, not router.replace().
      //
      // `redirectTo` only applies to OAuth and magic-link flows, so a code
      // sign-in has to navigate itself. But the destination is a server
      // component behind middleware, and both read the session COOKIE — which
      // ConvexAuthNextjsProvider writes asynchronously after signIn resolves.
      // A client-side navigation races that write and can arrive before the
      // server can see the session, bouncing straight back to sign-in.
      // A hard load cannot start until the browser has the cookie.
      window.location.assign(redirectTo);
    } catch {
      setError("That code did not work. It may have expired — send a new one.");
    } finally {
      // Always clear it. A successful sign-in that leaves the button on
      // "Checking…" reads as a REJECTED code: the user retries, burns the
      // code, and concludes auth is broken while their session works.
      setBusy(false);
    }
  }

  return (
    <div
      className={world === "admin" ? "world-admin" : "world-client"}
      style={world === "client" ? accent : undefined}
    >
      <main className={s.wrap}>
        <div className={s.panel}>
          <p className={s.eyebrow}>{businessName ?? "The Creative Current"}</p>

          {step === "email" ? (
            <>
              <h1 className={s.heading}>Sign in</h1>
              <p className={s.body}>
                We will email you an eight-digit code. There is no password to
                remember or lose.
              </p>

              <form className={s.form} onSubmit={sendCode} noValidate>
                <div className={s.field}>
                  <label className={s.label} htmlFor="email">
                    Email address
                  </label>
                  <input
                    id="email"
                    className={s.control}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoFocus
                    value={email}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? "signin-error" : undefined}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError(null);
                    }}
                  />
                </div>

                {error ? (
                  <p className={s.error} id="signin-error" role="alert">
                    {error}
                  </p>
                ) : null}

                <button className={s.submit} type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Email me a code"}
                </button>
              </form>

              <p className={s.footnote}>
                Access is by invitation. If you were not invited, there is
                nothing here to sign in to.
              </p>
            </>
          ) : (
            <>
              <h1 className={s.heading}>Enter your code</h1>
              {/* Never confirms the address is known — only that we tried. */}
              <p className={s.body}>
                If <span className={s.email}>{email}</span> has access, an
                eight-digit code is on its way. It expires in 15 minutes.
              </p>

              <form className={s.form} onSubmit={verify} noValidate>
                <div className={s.field}>
                  <label className={s.label} htmlFor="code">
                    Eight-digit code
                  </label>
                  <input
                    id="code"
                    ref={codeRef}
                    className={`${s.control} ${s.code} tabular`}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={9}
                    placeholder="000 000 00"
                    value={code}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? "signin-error" : undefined}
                    onChange={(e) => {
                      setCode(e.target.value.replace(/[^\d\s]/g, ""));
                      setError(null);
                    }}
                  />
                </div>

                {error ? (
                  <p className={s.error} id="signin-error" role="alert">
                    {error}
                  </p>
                ) : null}

                <button className={s.submit} type="submit" disabled={busy}>
                  {busy ? "Checking…" : "Sign in"}
                </button>
              </form>

              <div className={s.actions}>
                <button
                  type="button"
                  className={s.link}
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                    setResent(false);
                  }}
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  className={s.link}
                  disabled={busy || resent}
                  onClick={async () => {
                    await sendCode();
                    setResent(true);
                  }}
                >
                  {resent ? "Code re-sent" : "Send a new code"}
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
