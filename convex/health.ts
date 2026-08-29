import { internalQuery } from "./_generated/server";

/**
 * Is this deployment's auth actually configured?
 *
 * Exists because the failure it detects is silent and expensive: JWKS set to
 * malformed JSON — trivially done by a shell that rewrites quotes — makes
 * EVERY token verification fail with `AuthProviderDiscoveryFailed`. Nothing
 * errors at set time. It surfaces as "the middleware thinks nobody is signed
 * in" and "the back office says not found", which look like application bugs
 * and were debugged as such for an hour.
 *
 * Run it after setting the vars on any deployment, and before believing that
 * a broken sign-in is your code:
 *
 *   npx convex run health:authConfig
 */
export const authConfig = internalQuery({
  args: {},
  handler: async () => {
    const jwks = process.env.JWKS;

    let jwksStatus: string;
    if (!jwks) {
      jwksStatus = "MISSING";
    } else {
      try {
        const parsed = JSON.parse(jwks);
        jwksStatus = Array.isArray(parsed.keys)
          ? `ok — ${parsed.keys.length} key(s)`
          : "INVALID — parsed, but has no `keys` array";
      } catch {
        // Almost always shell quote-stripping: {keys:[...]} not {"keys":[...]}.
        jwksStatus = "INVALID JSON — likely set from a shell that stripped the quotes";
      }
    }

    return {
      JWKS: jwksStatus,
      JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY
        ? process.env.JWT_PRIVATE_KEY.startsWith("-----BEGIN PRIVATE KEY-----")
          ? "ok"
          : "INVALID — not a PKCS8 PEM"
        : "MISSING",
      SITE_URL: process.env.SITE_URL ?? "MISSING",
      AUTH_RESEND_KEY: process.env.AUTH_RESEND_KEY
        ? process.env.AUTH_RESEND_KEY.startsWith("re_")
          ? `ok — ${process.env.AUTH_RESEND_KEY.length} chars`
          : "INVALID — does not start with re_"
        : "MISSING",
      AUTH_EMAIL_FROM: process.env.AUTH_EMAIL_FROM ?? "MISSING (falls back to a default)",
      CONVEX_SITE_URL: process.env.CONVEX_SITE_URL ?? "MISSING",
    };
  },
});
