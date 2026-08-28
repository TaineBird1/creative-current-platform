// @vitest-environment node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FUNCTION_PATHS } from "./api";

/**
 * DRIFT GUARD for lib/api.ts.
 *
 * Hand-declared function references are the price of building before a Convex
 * login exists. The risk they carry is silent divergence: someone renames a
 * function or changes an argument, TypeScript stays green because these types
 * are declared rather than inferred, and the failure only appears at runtime
 * on a client's live site.
 *
 * These tests close the part of that gap a test can reach — the paths and the
 * argument NAMES. They cannot check types. That is why this file is temporary:
 * once `npx convex dev` has run, delete lib/api.ts, import
 * `convex/_generated/api` instead, and delete this file with it.
 */

const CONVEX_DIR = join(__dirname, "..", "..", "..", "convex");

function moduleSource(modulePath: string): string {
  const file = join(CONVEX_DIR, `${modulePath}.ts`);
  if (!existsSync(file)) throw new Error(`convex/${modulePath}.ts does not exist`);
  return readFileSync(file, "utf8");
}

describe("function references match the backend", () => {
  test.each(FUNCTION_PATHS)("%s exists as an exported function", (path) => {
    const [modulePath, fnName] = path.split(":");
    const source = moduleSource(modulePath!);
    const exported = new RegExp(`export\\s+const\\s+${fnName}\\s*=`).test(source);
    expect(exported, `convex/${modulePath}.ts does not export "${fnName}"`).toBe(true);
  });

  test("resolve accepts host and slug", () => {
    const source = moduleSource("public/site");
    const args = source.match(/export const resolve = query\(\{\s*args:\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(args).toContain("host");
    expect(args).toContain("slug");
  });

  test("redirectFor accepts slug and path", () => {
    const source = moduleSource("public/site");
    const args = source.match(/export const redirectFor = query\(\{\s*args:\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(args).toContain("slug");
    expect(args).toContain("path");
  });

  test("submit accepts every argument the action sends", () => {
    const source = moduleSource("public/quote");
    const args = source.match(/export const submit = mutation\(\{\s*args:\s*\{([\s\S]*?)\n  \},/)?.[1] ?? "";
    for (const field of [
      "slug", "sectionId", "name", "phone", "email",
      "answers", "photoStorageIds", "consentAccepted", "userAgent",
    ]) {
      expect(args, `public/quote:submit is missing "${field}"`).toContain(`${field}:`);
    }
  });

  test("this whole file becomes obsolete once _generated exists", () => {
    // Not a failure — a reminder that lands the moment the login happens.
    const generated = join(CONVEX_DIR, "_generated", "api.d.ts");
    if (existsSync(generated)) {
      console.warn(
        "convex/_generated exists: delete apps/sites/lib/api.ts, import " +
          "convex/_generated/api instead, and delete this test.",
      );
    }
    expect(true).toBe(true);
  });
});
