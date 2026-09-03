#!/usr/bin/env node
/**
 * Set JWT_PRIVATE_KEY and JWKS on a Convex deployment, without a shell.
 *
 * THIS SCRIPT EXISTS TO DELETE A WARNING.
 *
 * CLAUDE.md used to carry a long paragraph saying "never set these from
 * PowerShell", because PowerShell strips the double quotes out of JSON before
 * the CLI sees them: `JWKS` lands as `{keys:[...]}` instead of
 * `{"keys":[...]}`, Convex cannot build a key set, and EVERY token
 * verification fails with `AuthProviderDiscoveryFailed`. That surfaces as
 * "middleware thinks nobody is signed in", "the back office says not found",
 * and a client retry storm. It cost an hour of misdiagnosis once already.
 *
 * A warning is a barrier that has to be READ, by the right person, on the day
 * they are in a hurry. This removes the capability instead: `spawn` with no
 * shell, so there is no command line for anything to re-quote, and the value
 * itself goes to the CLI through `--from-file` so it never appears in argv
 * either. Not a safer way to type the command — the absence of the thing that
 * went wrong.
 *
 * `--from-file` rather than `env set NAME <value>` for a second reason, found
 * by this script's own verify step rather than by reading: a PEM begins
 * `-----BEGIN PRIVATE KEY-----`, and the CLI's option parser reads a leading
 * `-` as a flag. `JWT_PRIVATE_KEY` failed with `error: unknown option
 * '-----BEGIN PRIVATE KEY----- ...'` while JWKS went through fine. Passing a
 * path sidesteps the ambiguity completely, and it means a value can never be
 * mistaken for an option no matter what it starts with.
 *
 * That is also why it invokes `node_modules/convex/bin/main.js` with
 * `process.execPath` rather than `npx convex`: `npx` on Windows is a `.cmd`
 * shim, and running a `.cmd` requires `shell: true`, which puts a command
 * line back in the middle and reintroduces exactly the quoting hazard.
 *
 * IT VERIFIES, rather than assuming. After writing, it reads the value back
 * and compares it byte for byte with what it meant to set. A silently-mangled
 * key is the entire failure mode here, and it does not throw at set time — it
 * throws at every sign-in, later, to somebody else.
 *
 * BOTH KEYS BY DEFAULT, because they are a matching PAIR: rotating one alone
 * invalidates every existing session, and a script that made the half-rotation
 * convenient would be a new footgun rather than a removed one. `--only jwks`
 * exists for the one legitimate single-key case — repairing a JWKS that a
 * shell already mangled, when the private key is known good — and says so out
 * loud when used.
 *
 * Usage (all of these run in PowerShell, which is the point):
 *
 *   node scripts/gen-auth-keys.mjs --write     # writes .auth-keys.json
 *   node scripts/set-auth-keys.mjs             # set BOTH on dev
 *   node scripts/set-auth-keys.mjs --prod      # set BOTH on production
 *   node scripts/set-auth-keys.mjs --only jwks # repair JWKS alone
 *   node scripts/set-auth-keys.mjs --from path/to/keys.json
 *   node scripts/set-auth-keys.mjs --dry-run   # print what it would do
 *
 * Then check it took:
 *   npx convex run health:authConfig
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const die = (...lines) => {
  console.error("");
  for (const line of lines) console.error("  " + line);
  console.error("");
  process.exit(1);
};

/* ---------------------------------------------------------------- source */

const from = valueOf("--from") ?? join(ROOT, ".auth-keys.json");
if (!existsSync(from)) {
  die(
    `No key file at ${from}.`,
    "",
    "Generate one first — it is gitignored:",
    "  node scripts/gen-auth-keys.mjs --write",
    "",
    "Or point at an existing file with --from <path>.",
  );
}

let keys;
try {
  keys = JSON.parse(readFileSync(from, "utf8"));
} catch (error) {
  die(`${from} is not valid JSON: ${error.message}`);
}

/*
 * WHAT TO SET. Both unless told otherwise, and `--only` is checked against a
 * fixed list so a typo refuses rather than silently setting nothing — the
 * quiet no-op being a close cousin of the failure this script exists to stop.
 */
const ONLY = { jwks: ["JWKS"], private: ["JWT_PRIVATE_KEY"] };
const only = valueOf("--only");
if (only !== undefined && !(only in ONLY)) {
  die(`--only takes ${Object.keys(ONLY).join(" or ")}, not "${only}".`);
}
const names = only ? ONLY[only] : ["JWT_PRIVATE_KEY", "JWKS"];

for (const name of names) {
  if (typeof keys[name] !== "string" || keys[name].length === 0) {
    die(`${from} has no usable ${name}.`);
  }
}

/*
 * The JSON check that the whole hazard is about. Done BEFORE anything is sent,
 * because a mangled value that reaches the deployment breaks sign-in for
 * everybody and the error appears nowhere near here.
 */
if (names.includes("JWKS")) {
  let parsed;
  try {
    parsed = JSON.parse(keys.JWKS);
  } catch (error) {
    die(
      `JWKS in ${from} is not valid JSON: ${error.message}`,
      "",
      "If it looks like {keys:[...]} rather than {\"keys\":[...]}, a shell has",
      "already eaten the quotes — regenerate rather than repairing by hand.",
    );
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    die("JWKS parses but has no `keys` array. Convex cannot build a key set from it.");
  }
}

if (only) {
  console.log(
    `\n  Setting ${names.join(" and ")} ONLY.\n` +
      "  These are a matching pair — if the other half does not already agree\n" +
      "  with this one, every existing session is invalidated.\n",
  );
}

/* ----------------------------------------------------------- deployment */

const prod = has("--prod");
const target = prod ? "production" : "dev";
const deploymentArgs = prod ? ["--prod"] : [];

/*
 * Resolved by PATH, not by `require.resolve`. Convex's package.json `exports`
 * map does not expose `./bin/main.js`, so resolving it as a module subpath
 * throws ERR_PACKAGE_PATH_NOT_EXPORTED — which is a legitimate thing for a
 * package to do about its own internals, and not worth working around with a
 * shell.
 */
const convexCli = join(ROOT, "node_modules", "convex", "bin", "main.js");
if (!existsSync(convexCli)) {
  die(
    `Cannot find the Convex CLI at ${convexCli}.`,
    "Run `pnpm install` first. This script deliberately does not fall back to",
    "`npx convex`: npx on Windows is a .cmd shim, running it needs shell:true,",
    "and a shell is the thing that mangles JWKS in the first place.",
  );
}

/**
 * Run the Convex CLI. Values reach it as file paths, never as argv content.
 *
 * `shell: false` is the whole point and is the default — stated explicitly so
 * that flipping it reads as the deliberate mistake it would be.
 */
function convex(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [convexCli, ...args], {
      cwd: ROOT,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const shorten = (v) => `${v.length} chars, sha ${hash(v)}`;

function hash(value) {
  // Enough to compare two values in a log without printing either.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

if (has("--dry-run")) {
  console.log(`\n  Would set on ${target}:`);
  for (const name of names) console.log(`    ${name} — ${shorten(keys[name])}`);
  console.log("\n  No shell, and no value in argv: each is handed over as a file path.\n");
  process.exit(0);
}

/* -------------------------------------------------------------- set it */

console.log(`\n  Target: ${target}\n`);

let failed = false;

/*
 * A directory only this user can read, removed in the `finally` below. The
 * private key is already on disk in `.auth-keys.json` — that is the documented
 * flow — so this adds no new exposure, but it is short-lived regardless.
 */
const scratch = mkdtempSync(join(tmpdir(), "cc-auth-"));

try {
for (const name of names) {
  const value = keys[name];

  /*
   * Written WITHOUT a trailing newline: the read-back below compares byte for
   * byte, so anything this adds would show up as a mismatch rather than being
   * silently stored.
   */
  const valueFile = join(scratch, `${name}.value`);
  writeFileSync(valueFile, value, { encoding: "utf8", mode: 0o600 });

  const set = await convex(["env", "set", ...deploymentArgs, name, "--from-file", valueFile]);
  if (set.code !== 0) {
    console.error(`  ${name}: FAILED to set`);
    console.error((set.err || set.out).trim().split("\n").map((l) => "      " + l).join("\n"));
    failed = true;
    continue;
  }

  /*
   * READ IT BACK. The mangling this script prevents does not error at set
   * time — it errors at every sign-in afterwards, to somebody else, with a
   * message that names none of this.
   */
  const got = await convex(["env", "get", ...deploymentArgs, name]);
  if (got.code !== 0) {
    console.error(`  ${name}: set, but could not be read back to verify`);
    failed = true;
    continue;
  }

  const readBack = got.out.replace(/\r?\n$/, "");
  if (readBack === value) {
    console.log(`  ${name}: set and verified byte-for-byte (${shorten(value)})`);
  } else {
    console.error(`  ${name}: SET BUT DOES NOT MATCH`);
    console.error(`      sent     ${shorten(value)}`);
    console.error(`      read back ${shorten(readBack)}`);
    console.error("      Something between here and the deployment altered the value.");
    failed = true;
  }
}

} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failed) {
  die("At least one value did not round-trip. Sign-in may be broken — fix before deploying.");
}

console.log("  Confirm the deployment agrees:");
console.log(`    npx convex run${prod ? " --prod" : ""} health:authConfig\n`);
