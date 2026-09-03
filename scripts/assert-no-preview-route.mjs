import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE PREVIEW HARNESS IS NOT IN THIS BUILD. CHECKED, NOT BELIEVED.
 *
 * `app/preview/**` renders the shape of a TENANT'S BOOKINGS and a client's
 * INVOICE — customer names, phone numbers, amounts owed. Three barriers keep
 * it out of production, and until now all three were asserted against SOURCE:
 * guards.test.ts reads next.config.mjs, turbo.json and the page files and
 * concludes the route cannot ship.
 *
 * That is a claim about what a build WILL do, verified by reading the inputs.
 * This checks the build itself. The difference is the whole point: a source
 * scan cannot see a Next version that changes how pageExtensions works, a
 * dependency that injects routes, a stray `page.tsx` added under a directory
 * the scan does not walk, or any of the ways a build surprises the person who
 * configured it. The claim being made is about the artifact, so the artifact
 * is what gets read.
 *
 * FAILS IF IT CANNOT FIND THE BUILD. A guard that silently passes when the
 * manifest is missing reports safety it never checked — and it does it in
 * green, which is how three of four preview controls once passed against
 * deliberately broken code. It also asserts the manifest contains routes it
 * MUST contain, because a manifest that parsed to an empty object would
 * otherwise satisfy "no preview route" perfectly.
 *
 * Usage: node scripts/assert-no-preview-route.mjs [appDir]
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = process.argv[2] ? join(root, process.argv[2]) : join(root, "apps", "office");
const nextDir = join(appDir, ".next");

const fail = (...lines) => {
  console.error("\n  PREVIEW ROUTE GUARD FAILED\n");
  for (const line of lines) console.error("  " + line);
  console.error("");
  process.exit(1);
};

if (!existsSync(nextDir)) {
  fail(
    `No build found at ${nextDir}.`,
    "This guard reads the built route manifest, so it must run AFTER",
    "`pnpm --filter @cc/office build`. Passing without a build to inspect",
    "would report safety it never checked.",
  );
}

/**
 * Next writes several manifests. `app-path-routes-manifest.json` maps every
 * app-router page file to its URL path, which is the most direct statement of
 * "these are the routes"; `routes-manifest.json` carries the compiled dynamic
 * matchers. Both are read — one of them missing is a Next version change, and
 * that is exactly when this check matters most.
 */
const MANIFESTS = ["app-path-routes-manifest.json", "routes-manifest.json"];

const found = [];
for (const name of MANIFESTS) {
  const path = join(nextDir, name);
  if (!existsSync(path)) continue;
  found.push({ name, raw: readFileSync(path, "utf8") });
}

if (found.length === 0) {
  fail(
    `Found a .next directory but none of: ${MANIFESTS.join(", ")}.`,
    "Next has changed where it records routes. Update this guard to read the",
    "new manifest — do not delete it, because the claim it checks is that a",
    "harness rendering customer names and invoice amounts cannot ship.",
  );
}

/*
 * The floor, and the names. A count alone survives a guard pointed at the
 * wrong tree; naming routes that must be present is what proves this manifest
 * is the office app's rather than something else that happens to parse.
 */
const MUST_CONTAIN = ["/admin", "/i/[token]", "/c/[slug]"];
const combined = found.map((f) => f.raw).join("\n");

for (const route of MUST_CONTAIN) {
  if (!combined.includes(route)) {
    fail(
      `The build manifest does not mention ${route}.`,
      "Either this is not the office app's build, or its routes have been",
      "renamed. Both mean the absence of /preview below proves nothing —",
      "a manifest with no routes in it satisfies this guard trivially.",
      "",
      `Manifests read: ${found.map((f) => f.name).join(", ")}`,
    );
  }
}

/*
 * The actual assertion. Matched on the path segment rather than the substring
 * so a legitimate future route containing the word — `/admin/previews` — does
 * not fail this, while `/preview` and anything beneath it does.
 */
const offenders = new Set();
for (const { name, raw } of found) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${name} is not valid JSON: ${error.message}`);
  }

  const walk = (node) => {
    if (typeof node === "string") {
      if (/(^|["/])preview(\/|"|$)/.test(node) && node.includes("/preview")) {
        offenders.add(`${name}: ${node}`);
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        walk(key);
        walk(value);
      }
    }
  };
  walk(parsed);
}

if (offenders.size > 0) {
  fail(
    "A production build of apps/office CONTAINS a /preview route:",
    "",
    ...[...offenders].map((o) => "  " + o),
    "",
    "That harness renders a tenant's customer names, phone numbers and",
    "invoice amounts from fixtures — on an UNAUTHENTICATED path, because",
    "/preview is on the public route allowlist. Shipping it is the failure",
    "the three barriers exist to prevent.",
    "",
    "If ALLOW_PREVIEW_ROUTES was set for this build, that is the bug: it",
    "must never be set for a build that gets deployed, and turbo.json does",
    "not declare it precisely so a Vercel build cannot see it.",
  );
}

console.log(
  `✓ no /preview route in the office build ` +
    `(read ${found.map((f) => f.name).join(", ")}; ` +
    `confirmed ${MUST_CONTAIN.join(", ")} present)`,
);
