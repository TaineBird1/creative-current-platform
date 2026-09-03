import { spawn } from "node:child_process";

/**
 * Start the office dev server WITH the preview harness routed.
 *
 * `ALLOW_PREVIEW_ROUTES=1 pnpm --filter @cc/office dev` is the documented
 * incantation and it only works in a POSIX shell. On Windows — which is where
 * this repo is actually developed — PowerShell parses that as a command name
 * and cmd.exe treats it as a syntax error, so the documented way to look at
 * the only harness for the back office does not run on the machine that has
 * to run it.
 *
 * Node sets the variable the same way everywhere, so this does. No new
 * dependency: cross-env would be a package to install for one line.
 *
 * This does NOT weaken any barrier. The flag still has to be set deliberately,
 * it still cannot reach a Vercel build (turbo.json does not declare it, so
 * Turborepo filters it out), the files are still `page.preview.tsx` and so
 * still unroutable without pageExtensions, and each page still refuses on its
 * own. This only makes the deliberate local case typeable.
 */

const child = spawn("pnpm", ["--filter", "@cc/office", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, ALLOW_PREVIEW_ROUTES: "1" },
});

child.on("exit", (code) => process.exit(code ?? 0));
