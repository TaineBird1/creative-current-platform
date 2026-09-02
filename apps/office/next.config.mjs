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

/*
 * THE PREVIEW HARNESS IS NOT A ROUTE UNLESS THIS BUILD SAYS SO.
 *
 * `app/preview/**` renders the shape of a TENANT'S BOOKINGS — customer names
 * and phone numbers. It is fixtures today, and it is the real component, which
 * is exactly why the next person points it at real data to check something.
 *
 * So it is not conditionally hidden, it is conditionally COMPILED. The files
 * are named `page.preview.tsx`, which Next does not recognise as a page
 * unless `preview.tsx` is in pageExtensions — so on any build without the
 * flag the route does not exist, is not in the manifest, and is not in the
 * bundle. A runtime check is one env mistake away from publishing a client's
 * customer list; an absent route is not.
 *
 * THE LOAD-BEARING PART IS THAT turbo.json DOES NOT DECLARE
 * ALLOW_PREVIEW_ROUTES. Turborepo filters the environment to what a task
 * names, so a Vercel build cannot see this variable even if somebody sets it
 * in the dashboard — the mistake is not available to make. Local `next dev`
 * runs outside turbo and sees it, which is the only place it is wanted.
 * guards.test.ts fails if it ever appears in turbo.json.
 */
const PREVIEW_ROUTES = process.env.ALLOW_PREVIEW_ROUTES === "1";

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  pageExtensions: ["tsx", "ts", "jsx", "js", ...(PREVIEW_ROUTES ? ["preview.tsx"] : [])],
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
