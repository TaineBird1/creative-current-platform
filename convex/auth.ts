import { convexAuth } from "@convex-dev/auth/server";
import { Email } from "@convex-dev/auth/providers/Email";
import { resolveSignIn } from "./lib/invites";

/**
 * INVITE-ONLY AUTH.
 *
 * On the PUBLIC_ALLOWLIST in guards.test.ts: sign-in runs before a session
 * exists, so it cannot be a guarded function.
 *
 * Why an emailed CODE rather than a magic link or passkeys:
 *   - The invite arrives on WhatsApp, and a magic link opened from a chat app
 *     lands in an in-app browser that does not share cookies with the user's
 *     real browser. The session appears to work and then vanishes. A code the
 *     person types works in whichever browser they are actually in.
 *   - Passkeys are stronger, but these users are small-business owners on
 *     mixed Android hardware who change phones without migrating anything.
 *     Account recovery would become the support burden that kills the tier.
 *     Passkeys belong here later as an upgrade, not as the only door.
 */

const CODE_TTL_SECONDS = 15 * 60;

const ResendOTP = Email({
  id: "resend-otp",
  maxAge: CODE_TTL_SECONDS,

  /**
   * Eight digits, from a CSPRNG with rejection sampling so the distribution
   * is flat. `Math.random()` is not acceptable for something that grants a
   * session, and modulo bias on a short code is a real narrowing of entropy.
   */
  async generateVerificationToken() {
    const digits: string[] = [];
    while (digits.length < 8) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      for (const byte of bytes) {
        if (byte >= 250) continue; // 250 = 25 * 10, the largest flat range
        digits.push(String(byte % 10));
        if (digits.length === 8) break;
      }
    }
    return digits.join("");
  },

  async sendVerificationRequest({ identifier: email, token, expires }) {
    const key = process.env.AUTH_RESEND_KEY;
    if (!key) {
      throw new Error(
        "AUTH_RESEND_KEY is not set on this deployment. " +
          "Run: npx convex env set AUTH_RESEND_KEY=<key>",
      );
    }

    const minutes = Math.max(1, Math.round((expires.getTime() - Date.now()) / 60000));
    const from = process.env.AUTH_EMAIL_FROM ?? "The Creative Current <hello@thecreativecurrent.co.za>";

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `${token} is your sign-in code`,
        // The code is in the subject line as well, so it is readable from a
        // phone's notification without opening anything.
        text: [
          `Your sign-in code is ${token}`,
          "",
          `It expires in ${minutes} minutes and can only be used once.`,
          "If you did not ask to sign in, you can ignore this — nobody can get",
          "in without the code.",
        ].join("\n"),
      }),
    });

    if (!response.ok) {
      throw new Error(`Resend refused the send: ${response.status} ${await response.text()}`);
    }
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [ResendOTP],

  callbacks: {
    /**
     * THE GATE. This is the only place a `users` row is ever created, so it is
     * the only place invite-only has to be enforced — and it throws rather
     * than creating an inert account, because an account that exists but can
     * reach nothing is indistinguishable from a bug to whoever holds it.
     *
     * Note what is NOT trusted: the caller cannot pass a role, a client, or an
     * invite id. The invite is looked up by the email the provider just
     * verified, so possession of a mailbox is the whole claim.
     */
    async createOrUpdateUser(ctx, args) {
      return resolveSignIn(ctx, {
        existingUserId: args.existingUserId,
        email: args.profile.email ?? null,
      });
    },
  },
});
