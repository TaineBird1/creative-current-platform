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

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ["@cc/site-config", "@cc/tokens"],
  experimental: { optimizePackageImports: ["@cc/site-config"] },
  env: { CONVEX_URL: process.env.CONVEX_URL ?? "" },
};
