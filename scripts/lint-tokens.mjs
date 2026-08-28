#!/usr/bin/env node
/**
 * TOKENS ONLY. Fails on raw hex and inline font declarations outside the
 * tokens file.
 *
 * This script exists because the design rules in DESIGN.md do not survive a
 * session boundary and a skill does not run itself. A failing CI job does.
 *
 *   pnpm lint:tokens
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/** The one file allowed to contain raw colour values. */
const TOKENS_FILE = join("packages", "tokens", "src", "tokens.css");

/**
 * Files allowed raw hex for a stated reason:
 *   - accent.ts / primitives.ts : they COMPUTE colour; that is their job, and
 *     their output is validated against AA before it can be stored.
 *   - the token linter itself.
 */
const COLOUR_ALLOWLIST = new Set([
  TOKENS_FILE,
  join("packages", "site-config", "src", "accent.ts"),
  join("packages", "site-config", "src", "primitives.ts"),
  join("scripts", "lint-tokens.mjs"),
  // A brand colour is CONTENT, not styling -- clients hand you "#f26a1b" and
  // the preview route exists to feed one through the ramp. The rule is about
  // colour that ships as style, and this is the seam where data enters.
  join("apps", "sites", "app", "preview", "page.tsx"),
]);

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".turbo", "dist", "out", ".git", "_generated",
]);

const EXTENSIONS = [".css", ".ts", ".tsx", ".jsx", ".js"];

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) acc.push(full);
  }
  return acc;
}

/**
 * Test files are fixtures, not shipped styling. A contrast test MUST contain
 * literal colours -- they are its inputs. Exempting them keeps the rule
 * meaningful rather than something people learn to route around.
 */
const isTest = (rel) => /\.test\.[tj]sx?$/.test(rel);

const RULES = [
  {
    id: "raw-hex",
    // #abc, #aabbcc, #aabbccdd
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
    message: "raw hex colour — use a token from packages/tokens/src/tokens.css",
    allow: COLOUR_ALLOWLIST,
    skipTests: true,
  },
  {
    id: "raw-colour-fn",
    pattern: /\b(?:rgb|rgba|hsl|hsla|oklch|lab)\(\s*[\d.]/g,
    message: "literal colour function — use a token",
    allow: COLOUR_ALLOWLIST,
    skipTests: true,
  },
  {
    id: "inline-font",
    // Capture the VALUE and test it, rather than putting a negative lookahead
    // after \s* — that backtracks to zero width, the lookahead then passes on
    // the space, and the rule flags the exact thing it exists to permit.
    pattern: /font-family\s*:([^;\n]+)/g,
    valueOk: (value) => value.trim().startsWith("var("),
    message: "inline font-family — use var(--font-sans|--font-display|--font-mono)",
    allow: new Set([TOKENS_FILE]),
  },
  {
    id: "magic-radius",
    pattern: /border-radius\s*:([^;\n]+)/g,
    valueOk: (value) => !/^\s*\d/.test(value),
    message: "hard-coded radius — use var(--radius-*)",
    allow: new Set([TOKENS_FILE]),
  },
];

let failures = 0;
const files = walk(ROOT);

for (const file of files) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  for (const rule of RULES) {
    if (rule.allow.has(rel)) continue;
    if (rule.skipTests && isTest(rel)) continue;
    lines.forEach((line, i) => {
      // A comment explaining a colour is fine; a colour that ships is not.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const matches = [...line.matchAll(rule.pattern)];
      if (matches.length === 0) return;
      for (const match of matches) {
        if (rule.valueOk && match[1] !== undefined && rule.valueOk(match[1])) continue;
        failures++;
        console.error(`${rel.split(sep).join("/")}:${i + 1}  [${rule.id}] ${rule.message}`);
        console.error(`    ${line.trim()}`);
      }
    });
  }
}

if (failures > 0) {
  console.error(`\n✖ ${failures} token violation${failures === 1 ? "" : "s"}.`);
  console.error("Tokens live in packages/tokens/src/tokens.css. Add one there, then use it.");
  process.exit(1);
}

console.log(`✓ tokens: ${files.length} files clean`);
