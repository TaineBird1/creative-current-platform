#!/usr/bin/env node
/**
 * Generate a Convex Auth RS256 keypair and print the two env values.
 *
 * A script rather than a documented one-liner, for a reason that already bit
 * this repo twice: the inline version contains `\n` inside a shell-quoted JS
 * string, and every layer it passes through — PowerShell, a heredoc, a
 * markdown code fence — is another chance for that escape to collapse. When
 * it does, the output is silently wrong rather than absent.
 *
 * NEVER use the interactive `npx @convex-dev/auth` wizard; it needs a TTY and
 * hangs in CI or a headless run.
 *
 *   node scripts/gen-auth-keys.mjs            # print (then set them yourself)
 *   node scripts/gen-auth-keys.mjs --write    # write .auth-keys.json, gitignored
 *
 * Then set BOTH — they are a matching pair, and rotating one alone
 * invalidates every existing session:
 *
 *   node scripts/set-auth-keys.mjs          # dev
 *   node scripts/set-auth-keys.mjs --prod   # production
 *
 * That script hands each value to the CLI as a FILE, never through a shell or
 * argv, so nothing can rewrite the quotes in JWKS — which is JSON, and which
 * PowerShell used to corrupt silently. It reads the values back and compares
 * them byte for byte before reporting success.
 */

import { writeFileSync } from "node:fs";
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";

const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });

const values = {
  // Convex expects the PEM on a single line, newlines replaced by spaces.
  JWT_PRIVATE_KEY: (await exportPKCS8(privateKey)).trimEnd().replace(/\n/g, " "),
  JWKS: JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(publicKey)) }] }),
};

// Fail loudly here rather than shipping a key set Convex cannot parse.
const parsed = JSON.parse(values.JWKS);
if (!Array.isArray(parsed.keys) || parsed.keys.length !== 1) {
  throw new Error("generated JWKS is malformed");
}

if (process.argv.includes("--write")) {
  writeFileSync(".auth-keys.json", JSON.stringify(values, null, 2));
  console.log("Wrote .auth-keys.json (gitignored). Delete it once the vars are set.");
} else {
  console.log(JSON.stringify(values, null, 2));
}
