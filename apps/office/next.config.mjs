import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * `npx convex dev` writes .env.local at the REPO ROOT, because convex/ lives
 * there. Next only reads env from the app directory, so without this the app
 * silently renders "not connected" against a perfectly good deployment.
 *
 * Read the root file rather than duplicating CONVEX_URL into a second .env —
 * one source of truth, written by the tool that owns it.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootEnv = join(repoRoot, ".env.local");

if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue; // a real env var always wins
    process.env[key] = rawValue.replace(/^["']|["']$/g, "").split(" #")[0].trim();
  }
}

/*
 * FAIL THE BUILD, not the browser.
 *
 * The office runs a browser Convex client, and @convex-dev/auth throws
 * `Missing environment variable NEXT_PUBLIC_CONVEX_URL` at runtime if it is
 * absent — after a green build and a successful deploy. `?? ""` below would
 * otherwise turn a missing var into an empty string that passes every check
 * and fails on the first page load.
 *
 * Set CONVEX_URL in Vercel; NEXT_PUBLIC_CONVEX_URL is derived from it so
 * there is one value to keep right. To build without a backend on purpose,
 * set CONVEX_URL to anything.
 */
if (process.env.NODE_ENV === "production" && !process.env.CONVEX_URL) {
  throw new Error(
    "CONVEX_URL is not set. apps/office cannot run without it — the browser " +
      "Convex client and Convex Auth both require it, and the failure would " +
      "otherwise appear at runtime, after a green deploy.",
  );
}

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ["@cc/site-config", "@cc/tokens"],
  experimental: {
    optimizePackageImports: ["@cc/site-config"],
  },
  env: {
    CONVEX_URL: process.env.CONVEX_URL ?? "",
    // Public by necessity: the office runs a browser Convex client, and
    // Convex Auth reads this exact name. It is a deployment address, not a
    // secret — every request to it is still authenticated, and every function
    // still re-derives its own tenant.
    NEXT_PUBLIC_CONVEX_URL: process.env.CONVEX_URL ?? "",
  },
};
