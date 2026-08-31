// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { IMMUTABLE_TABLES } from "./schema";

/**
 * THE STRUCTURAL GUARD.
 *
 * tenancy.test.ts proves the current functions are safe. This proves no FUTURE
 * function can quietly opt out. Skills and docs do not survive a session
 * boundary; a failing test does. Every rule here exists because breaking it is
 * silent at runtime.
 */

const CONVEX_DIR = __dirname;

/**
 * The only modules allowed to build functions with bare `query`/`mutation`.
 * Adding a file here is a deliberate security decision, reviewed as one.
 *   - public/*  : the unauthenticated public site and quote surface
 *   - http.ts   : provider webhooks, verified by signature not by session
 *   - auth.ts   : sign-in itself, which runs before a session exists
 */
const PUBLIC_ALLOWLIST = new Set([
  "public/site.ts",
  "public/quote.ts",
  "public/brand.ts",
  "http.ts",
  "auth.ts",
]);

/** The ONE file permitted to write the sites table. See decision 5. */
const SITE_CONFIG_WRITER = "siteConfigs.ts";

/** The ONE file permitted to write clients.resellerId. See decision 2. */
const RESELLER_WRITER = "lib/reseller.ts";

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

const sourceFiles = walk(CONVEX_DIR).map((f) => ({
  path: relative(CONVEX_DIR, f).replace(/\\/g, "/"),
  text: readFileSync(f, "utf8"),
}));

describe("tenancy", () => {
  test("every exported function uses a guarded constructor", () => {
    const offenders: string[] = [];
    // internalQuery/internalMutation/internalAction are excluded: they are not
    // reachable from a browser at all, only from other server functions.
    const bare = /export\s+const\s+\w+\s*=\s*(query|mutation|action)\s*\(/g;

    for (const file of sourceFiles) {
      if (PUBLIC_ALLOWLIST.has(file.path)) continue;
      if (file.path.startsWith("lib/")) continue; // lib defines the constructors
      for (const m of file.text.matchAll(bare)) {
        offenders.push(`${file.path}: uses bare ${m[1]}()`);
      }
    }

    expect(
      offenders,
      [
        "Use tenantQuery/tenantMutation (tenant data) or platformQuery/platformMutation",
        "(owner console) from convex/lib/functions.ts. If this function really is",
        "public, add its path to PUBLIC_ALLOWLIST above and say why.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("no TENANT-scoped function accepts a clientId argument", () => {
    const offenders: string[] = [];
    // The rule is about tenant scope, and only tenant scope.
    //
    // A tenantQuery/tenantMutation derives its client from the caller's own
    // memberships; taking a clientId argument would hand that choice back to
    // the browser and reopen the exact hole the design closes.
    //
    // A platformQuery/platformMutation is different in kind: the caller has
    // already been verified as platform staff, and operating across every
    // tenant IS the owner console's job. `inviteClientOwner({ clientId })` is
    // correct there and would be impossible otherwise.
    //
    // `clientId: v.id("clients")` as a table COLUMN is required everywhere.
    for (const file of sourceFiles) {
      if (file.path.startsWith("lib/") || file.path.startsWith("tables/")) continue;
      if (file.path === "schema.ts" || PUBLIC_ALLOWLIST.has(file.path)) continue;

      // Each exported function, with its constructor and its args together.
      for (const chunk of file.text.split(/export const /).slice(1)) {
        const body = chunk.split(/\nexport /)[0]!;
        const isTenantScoped = /=\s*tenant(Query|Mutation)\s*\(/.test(body);
        if (!isTenantScoped) continue;

        const args =
          body.match(/args:\s*\{([\s\S]*?)\n {2}\},/)?.[1] ??
          body.match(/args:\s*\{([^}]*)\}/)?.[1] ??
          "";
        if (/clientId:\s*v\.id\("clients"\)/.test(args)) {
          const name = chunk.match(/^(\w+)/)?.[1] ?? "unknown";
          offenders.push(`${file.path}: ${name} takes clientId as an argument`);
        }
      }
    }
    expect(
      offenders,
      "Tenancy comes from ctx.tenant, derived from the authenticated user. Never from args.",
    ).toEqual([]);
  });

  test("immutable tables are never patched or deleted", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const table of IMMUTABLE_TABLES) {
        const pattern = new RegExp(`db\\.(patch|delete|replace)\\([^)]*${table}`, "g");
        if (pattern.test(file.text)) offenders.push(`${file.path}: mutates ${table}`);
      }
    }
    expect(
      offenders,
      "Ledger, audit log and consent rows are append-only. Correct with a reversing entry.",
    ).toEqual([]);
  });
});

describe("message keys", () => {
  /**
   * WHOEVER ADDS DRAG-RESCHEDULE WILL SEE THIS FIRST.
   *
   * A booking's confirmation and reminders carry `startsAt` AND
   * `messageRevision` in their idempotency key. That is what makes a
   * rescheduled booking a NEW message instead of one suppressed as a
   * duplicate — and a suppressed confirmation is invisible: nobody is told,
   * and the customer arrives at the old time.
   *
   * `book` is the only writer of `startsAt`, and it sets messageRevision to 1.
   * The moment a second writer appears — Part 2 names drag-reschedule, so it
   * is coming in M3, not hypothetical — that writer MUST bump
   * `messageRevision` in the same patch, or a 09:00 -> 10:00 -> 09:00 sequence
   * reproduces the first key and silently sends nothing.
   *
   * This is a test rather than a note in CLAUDE.md on purpose. A note does not
   * survive a session boundary; CI does.
   */
  const STARTS_AT_WRITER = "bookings.ts";

  test("only bookings.ts writes a booking's startsAt", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      if (file.path === STARTS_AT_WRITER) continue;

      // An insert into bookings anywhere else necessarily sets startsAt.
      if (/db\.insert\(\s*"bookings"/.test(file.text)) {
        offenders.push(`${file.path}: inserts into bookings`);
      }

      /*
       * A patch that mentions startsAt. Matched loosely on purpose: a false
       * positive here costs one comment, and a false negative costs a
       * customer standing outside a locked door.
       */
      for (const m of file.text.matchAll(/db\.patch\([^)]*\{[^}]*startsAt/gs)) {
        void m;
        offenders.push(`${file.path}: patches startsAt`);
      }
    }

    expect(
      offenders,
      [
        "A booking's startsAt is part of its message idempotency key.",
        "Any writer of startsAt MUST bump messageRevision in the same patch,",
        "or the customer's confirmation for the new time is suppressed as a",
        "duplicate and nobody is told the booking moved.",
        "",
        "If you are adding reschedule: bump messageRevision, then add this file",
        "to STARTS_AT_WRITER above and say why it is safe.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("book sets messageRevision, so the key has something to vary on", () => {
    // Guards against the counter being quietly dropped from the insert.
    const bookings = sourceFiles.find((f) => f.path === STARTS_AT_WRITER);
    expect(bookings?.text).toMatch(/messageRevision:\s*1/);
  });
});

describe("the send choke point", () => {
  /**
   * Every rule a message must obey — never twice, never to demo or seed,
   * never without consent, never at night — is only safe if it is applied in
   * ONE place. "Remember to check isSeed" in three callers is two places to
   * forget, and the failure is a real message to a real business who never
   * signed up.
   */
  const DISPATCH = "lib/messaging.ts";

  test("only lib/messaging.ts writes the messages table", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === DISPATCH) continue;
      if (/db\.insert\(\s*"messages"/.test(file.text)) {
        offenders.push(`${file.path}: inserts into messages`);
      }
    }
    expect(
      offenders,
      [
        "Messages are created by dispatch() in convex/lib/messaging.ts and",
        "nowhere else. It is the single place that blocks demo/seed rows,",
        "checks consent, enforces the idempotency key and holds quiet hours.",
        "Inserting directly bypasses all four.",
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("single writers", () => {
  test("only siteConfigs.ts writes the sites table", () => {
    // The config column is v.any(), so the database will store anything. This
    // rule is what makes the Zod parse in siteConfigs.ts non-optional.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === SITE_CONFIG_WRITER) continue;
      if (/db\.insert\(\s*"sites"/.test(file.text)) {
        offenders.push(`${file.path}: inserts into sites`);
      }
      // A patch on a site doc is caught by the naming convention used
      // throughout: siteId, or site._id.
      if (/db\.(patch|replace)\(\s*site(Id|\._id)/.test(file.text)) {
        offenders.push(`${file.path}: patches a site`);
      }
    }
    expect(
      offenders,
      `SiteConfig is stored as v.any(). ${SITE_CONFIG_WRITER} is the only file that parses it through Zod before writing, so it must be the only file that writes.`,
    ).toEqual([]);
  });

  test("only lib/reseller.ts writes clients.resellerId", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === RESELLER_WRITER) continue;
      for (const m of file.text.matchAll(/db\.(patch|replace|insert)\([^;]*?resellerId/gs)) {
        offenders.push(`${file.path}: writes resellerId directly (${m[1]})`);
      }
    }
    expect(
      offenders,
      `Use setReseller() from ${RESELLER_WRITER}. It is what enforces depth exactly 1; a direct patch bypasses the check and the one-hop membership walk stops being correct.`,
    ).toEqual([]);
  });
});

describe("money rules", () => {
  test("no financial field is stored as bigint", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const m of file.text.matchAll(/(\w*[Cc]ents)\s*:\s*v\.int64\(\)/g)) {
        offenders.push(`${file.path}: ${m[1]} is v.int64()`);
      }
    }
    expect(
      offenders,
      "Money is integer cents as v.number(). bigint breaks JSON.stringify in every webhook, PDF and CSV path. Integer-ness comes from assertCents() in lib/money.ts.",
    ).toEqual([]);
  });

  test("every table carrying an amount carries a currency beside it", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (!file.path.startsWith("tables/")) continue;
      for (const block of file.text.split(/defineTable\(/).slice(1)) {
        const table = block.split("defineTable(")[0]!;
        if (/Cents/.test(table) && !/currency/.test(table)) {
          const name = table.match(/\.index\("([^"]+)"/)?.[1] ?? "unknown";
          offenders.push(
            `${file.path}: table near index ${name} has cents without a currency`,
          );
        }
      }
    }
    expect(
      offenders,
      "Never sum currencies. An amount stored without its currency is what invites it.",
    ).toEqual([]);
  });
});
