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

/**
 * Comments removed, so a guard cannot fire on the paragraph explaining it.
 *
 * Two of the webhook rules below caught their own documentation the first
 * time they ran: the comment saying "`request.json()` never appears in this
 * file" contains `request.json()`, and the one showing the banned
 * `if (!secret) return true` shape contains that shape. Both are exactly the
 * text most likely to exist near a rule worth having, so scanning it is a
 * false positive generator aimed at the most careful code.
 *
 * Deliberately crude — it does not know about `//` inside a string literal.
 * That is fine for the scans that use it (they look for API calls, not URLs),
 * and the guards where a loose match is WANTED keep using the raw text: a
 * false positive on `startsAt` costs one comment, a false negative costs a
 * customer standing outside a locked door.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sourceFiles = walk(CONVEX_DIR).map((f) => {
  const text = readFileSync(f, "utf8");
  return {
    path: relative(CONVEX_DIR, f).replace(/\\/g, "/"),
    text,
    /** Same file with comments removed. See stripComments. */
    code: stripComments(text),
  };
});

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

describe("the ledger", () => {
  /**
   * Money has the same shape of problem as messages: several rules that are
   * only rules if there is one place to break them. Whole cents, a sign that
   * matches the type, a client that belongs to its venture, and demo data
   * that never accrues — all applied in postEntry, all bypassed by a direct
   * insert, and none of them noisy when skipped. A wrong-signed refund does
   * not error; it reports the refund as revenue.
   */
  const LEDGER_WRITER = "lib/ledger.ts";

  test("only lib/ledger.ts writes the ledgerEntries table", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === LEDGER_WRITER) continue;
      if (/db\.insert\(\s*"ledgerEntries"/.test(file.text)) {
        offenders.push(`${file.path}: inserts into ledgerEntries`);
      }
    }
    expect(
      offenders,
      [
        "Ledger rows are written by postEntry() in convex/lib/ledger.ts and",
        "nowhere else. It is the single place that asserts whole cents, that",
        "the sign agrees with the type, that the client belongs to the venture,",
        "and that demo or seed data never accrues money.",
        "Every one of those failures is silent: the number still adds up.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("revenue is classified in one place, so a P&L cannot miss a type", () => {
    /*
     * This list lived in income.ts AND finance.ts. A type accepted by the
     * recorder and missed by the reporter is money that exists in the ledger
     * and never appears in a P&L — visible only as a total that is quietly
     * short.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === LEDGER_WRITER) continue;
      if (/(INCOME_TYPES|REVENUE_TYPES)\s*[:=]\s*\[/.test(file.text)) {
        offenders.push(`${file.path}: redefines the revenue types`);
      }
    }
    expect(offenders, "Import isRevenue from lib/ledger.ts instead.").toEqual([]);
  });
});

describe("the invoice boundary", () => {
  /**
   * WHERE THIS BACKEND STOPS, AND WHY IT IS A TEST.
   *
   * The ledger needs no registered entity: it records money that actually
   * moved, and that is true with or without letterhead. An INVOICE is the
   * other thing. It carries a legal name, a registration number and a
   * sequential number, it is the document a customer receives, and in South
   * Africa it is the document SARS reads. Issuing one before there is an
   * entity to issue it means sending a customer a number that belongs to
   * nobody.
   *
   * So `invoices` has no writer, and this is a test rather than a note,
   * because a note does not survive a session boundary. Whoever registers the
   * entity will find this failing and will have to state what the issuer is
   * before the first invoice can exist — which is the order those two things
   * have to happen in anyway.
   */
  test("nothing writes the invoices table yet", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (/db\.insert\(\s*"invoices"/.test(file.text)) {
        offenders.push(`${file.path}: inserts into invoices`);
      }
    }
    expect(
      offenders,
      [
        "An invoice is a legal document, not a ledger row. It needs an issuer",
        "legal name and a registration number, and there is no registered",
        "entity behind this platform yet.",
        "",
        "If you are adding invoicing: record the entity first, snapshot it onto",
        "each invoice at issue (never join to it — a company that renames must",
        "not silently rewrite documents already sent), then delete this test",
        "and say in the PR what the issuer is.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("a number is never allocated apart from the invoice it belongs to", () => {
    /**
     * THE RULE, DERIVED RATHER THAN ASSERTED.
     *
     * A GAP in the invoice sequence is recoverable: you explain it to an
     * accountant, once, and the explanation is boring. A DUPLICATE is not —
     * two documents bearing number INV-0042, sent to two different customers,
     * and no way to say afterwards which one the payment was for. So
     * numbering must prefer a gap, which the meta-rule settles without any
     * further argument.
     *
     * Preferring a gap forces the implementation: allocate the number and
     * insert the invoice in ONE mutation. Convex mutations are serializable,
     * so a counter read-and-patch inside the same transaction as the insert
     * cannot hand the same number to two concurrent issuers — one retries and
     * takes the next. Split them across two mutations and the failure between
     * the two produces a consumed number with no invoice: a gap, which is
     * survivable, and then a standing temptation to "tidy it up" by reusing
     * the number, which is the duplicate this rule exists to prevent.
     *
     * Nothing writes either table today, so this guard is aimed forward: it
     * fires on whoever builds invoicing, at the moment they get it wrong.
     */
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      // Per exported function, so "same file" is not mistaken for "same
      // transaction" — two mutations in one file are still two transactions.
      for (const chunk of file.text.split(/export const /).slice(1)) {
        const body = chunk.split(/\nexport /)[0]!;
        const name = chunk.match(/^(\w+)/)?.[1] ?? "unknown";

        const touchesCounter =
          /db\.(patch|replace|insert)\([^;]*invoiceCounter/s.test(body) ||
          /query\(\s*"invoiceCounters"/.test(body);
        const createsInvoice = /db\.insert\(\s*"invoices"/.test(body);

        if (touchesCounter && !createsInvoice) {
          offenders.push(`${file.path}: ${name} allocates a number without inserting the invoice`);
        }
        if (createsInvoice && !touchesCounter) {
          offenders.push(`${file.path}: ${name} inserts an invoice without allocating its number`);
        }
      }
    }

    expect(
      offenders,
      [
        "Allocate the invoice number and insert the invoice in ONE mutation.",
        "",
        "A gap in the sequence is recoverable — you explain it to an accountant.",
        "A duplicate is not: two documents with the same number, two customers,",
        "and no way to say which one a payment settled. So numbering prefers a",
        "gap, and that choice is only real if the two writes cannot come apart.",
        "",
        "Split across two mutations, a failure between them burns a number with",
        "no invoice behind it — and then someone 'tidies up' by reusing it.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("and no reader claims a receivables figure", () => {
    // A receivables total of R0 is a claim that nothing is owed, which is a
    // different statement from "we do not track this". Same reasoning that put
    // "not tracked" in the P&L instead of a zero.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const m of file.text.matchAll(/(outstandingCents|receivableCents|agingBuckets)/g)) {
        offenders.push(`${file.path}: reports ${m[1]}`);
      }
    }
    expect(
      offenders,
      "Nothing is owed until something has been issued. Do not report a zero for it.",
    ).toEqual([]);
  });
});

describe("webhooks", () => {
  /**
   * A webhook endpoint is a URL an unauthenticated stranger can find, and the
   * only thing standing between it and our ledger is a signature check that
   * has to happen FIRST. Both rules below protect that ordering, and both
   * failures are silent — the endpoint keeps returning 200 either way.
   */
  const WEBHOOK_ROUTES = "http.ts";

  test("no webhook handler parses a body before verifying it", () => {
    /*
     * `request.json()` is the specific hazard: it runs a parser over unverified
     * bytes, and it re-serialises, so a later signature check would compare
     * against different bytes from the ones that were signed — failing for a
     * reason that looks exactly like a wrong secret.
     */
    const routes = sourceFiles.find((f) => f.path === WEBHOOK_ROUTES);
    expect(routes, "convex/http.ts is missing").toBeTruthy();
    expect(
      /request\.json\(\)/.test(routes!.code),
      "Read request.text(), verify the signature over those exact bytes, then JSON.parse.",
    ).toBe(false);
    // And the raw read must actually be there.
    expect(routes!.code).toMatch(/request\.text\(\)/);
  });

  test("a missing webhook secret cannot degrade to accepting", () => {
    /*
     * The shape being banned is `if (!secret) return true` — an unconfigured
     * deployment that accepts forged payments from anyone who finds the URL,
     * silently, with a 200. The verifier throws instead, so the provider's own
     * retry queue holds the events until someone sets the secret.
     */
    const verifier = sourceFiles.find((f) => f.path === "lib/webhookVerify.ts");
    expect(verifier, "convex/lib/webhookVerify.ts is missing").toBeTruthy();

    const offenders: string[] = [];
    for (const m of verifier!.code.matchAll(
      /if\s*\(\s*!\s*secret\s*\)\s*(?:\{\s*)?return/g,
    )) {
      void m;
      offenders.push("webhookVerify returns instead of throwing on a missing secret");
    }
    expect(
      offenders,
      "A missing secret is a refusal (500), never a skip. Rejecting a real webhook is recoverable — the provider retries. Accepting a forged one is not.",
    ).toEqual([]);
  });

  test("webhook idempotency keys on the provider's event id, not ours", () => {
    // A key derived from the payload's contents cannot tell a retry apart from
    // a genuine second charge of the same amount to the same customer.
    const ingest = sourceFiles.find((f) => f.path === "webhooks.ts");
    expect(ingest?.code).toMatch(/by_provider_event/);
  });
});

describe("the sourcing spend cap", () => {
  /**
   * A sourcing run is a loop over a paid API. A bug in the loop is not a
   * crash, it is an invoice — and it is spent before anyone notices. So the
   * cap is a ledger the run writes to and checks, never a constant somebody
   * remembered to compare against.
   */
  const SPEND_WRITER = "lib/placesBudget.ts";

  test("only lib/placesBudget.ts writes the apiSpend ledger", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === SPEND_WRITER) continue;
      if (/db\.insert\(\s*"apiSpend"/.test(file.code)) {
        offenders.push(`${file.path}: inserts into apiSpend`);
      }
    }
    expect(
      offenders,
      [
        "Spend is recorded by reserveSpend() in convex/lib/placesBudget.ts and",
        "nowhere else. It is the single place that reads the period's total and",
        "refuses above the cap. A direct insert records the money without",
        "checking it, which is the same as having no cap.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("the cap is data, never a number compiled into a run", () => {
    /*
     * The shape being banned: `if (calls > 500) stop`. It looks like a cap and
     * is not one — it lives in one loop, it is invisible to whoever pays the
     * bill, and the next loop somebody writes does not have it.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === SPEND_WRITER) continue;
      for (const m of file.code.matchAll(/(MAX_(?:CALLS|REQUESTS|SPEND)|CALL_LIMIT|SPEND_LIMIT)\s*=/g)) {
        offenders.push(`${file.path}: hard-codes ${m[1]}`);
      }
    }
    expect(
      offenders,
      "The cap lives in the spendCaps table so the person paying can see and change it. Call reserveSpend() instead.",
    ).toEqual([]);
  });
});

describe("Places content we are licensed to keep", () => {
  /**
   * Google's terms: `place_id` is exempt and may be stored indefinitely.
   * Everything else the Places API returns is Google Maps Content under a
   * temporary caching allowance of 30 consecutive calendar days, and carries
   * attribution requirements when displayed.
   *
   * So the expiry is a column and the reader refuses past it. These guards
   * stop that becoming a comment nobody enforces.
   */
  const PLACES_CACHE_WRITER = "lib/places.ts";

  test("only lib/places.ts writes the Places cache", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === PLACES_CACHE_WRITER) continue;
      if (/db\.(insert|replace|patch)\(\s*"placesCache"/.test(file.code)) {
        offenders.push(`${file.path}: writes placesCache`);
      }
    }
    expect(
      offenders,
      "writePlace() computes expiresAt. A caller that writes directly can choose its own expiry, and one of them will choose never.",
    ).toEqual([]);
  });

  test("the cache window is the terms' 30 days, not a tuning knob", () => {
    const places = sourceFiles.find((f) => f.path === PLACES_CACHE_WRITER);
    expect(places?.code).toMatch(/30\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  test("no other table stores a Google rating or review count", () => {
    /*
     * `leads` used to hold `rating` and `reviewCount` with no expiry at all,
     * which is a permanent copy of content we hold under a 30-day allowance.
     * They live in placesCache now, where the clock is enforced on read.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (!file.path.startsWith("tables/")) continue;
      if (file.path === "tables/sourcing.ts") continue;
      for (const m of file.code.matchAll(/\b(rating|reviewCount):\s*v\./g)) {
        offenders.push(`${file.path}: stores ${m[1]}`);
      }
    }
    expect(
      offenders,
      "Google Maps Content lives in placesCache, which expires. Only place_id may be stored indefinitely.",
    ).toEqual([]);
  });
});

describe("suppression fails closed", () => {
  /**
   * The consent problem again, and it resolves the same way. A missed check
   * means phoning somebody who asked us not to — not recoverable. Being
   * wrongly suppressed is recoverable: a lead sits idle and someone notices.
   */
  const SUPPRESSION_READER = "lib/suppression.ts";

  test("only lib/suppression.ts reads the suppressions table", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === SUPPRESSION_READER) continue;
      if (/query\(\s*"suppressions"/.test(file.code)) {
        offenders.push(`${file.path}: queries suppressions directly`);
      }
    }
    expect(
      offenders,
      [
        "Call contactDecision() from convex/lib/suppression.ts. It is the one",
        "place that fails CLOSED — a lookup error, an unparseable phone or an",
        "ambiguous name fragment all resolve to blocked.",
        "",
        "A direct query returns rows and leaves the decision to the caller, and",
        "a caller that gets an empty array from a failed read will place the",
        "call. That failure is silent: nothing errors, and the only person who",
        "finds out is the one who asked not to be contacted.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("EVERY catch in the module resolves to nobody being contacted", () => {
    /*
     * Checks every catch block, not just the last one, and the difference is
     * not academic: this test originally read only the final block and went
     * green while a batch filter added above it was the one that mattered.
     * A file with three error paths needs three of them to fail closed.
     *
     * Two shapes count as failing closed, because the module has two return
     * types: a single verdict resolves to `blocked(...)`, and a batch filter
     * resolves to an empty allow-list. Returning the UNFILTERED input from a
     * batch catch is the specific disaster — a full queue that skipped the
     * check looks exactly like a normal working day.
     */
    const file = sourceFiles.find((f) => f.path === SUPPRESSION_READER);
    expect(file, "convex/lib/suppression.ts is missing").toBeTruthy();

    const blocks = file!.code.split(/\}\s*catch/).slice(1);
    expect(blocks.length, "no catch blocks found — has the module moved?").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const [index, rest] of blocks.entries()) {
      const body = rest.slice(0, rest.indexOf("\n}") + 1);
      const failsClosed = /blocked\(/.test(body) || /allowed:\s*\[\]/.test(body);
      if (!failsClosed) offenders.push(`catch #${index + 1}: ${body.trim().slice(0, 80)}`);
      if (/blocked:\s*false/.test(body)) offenders.push(`catch #${index + 1} returns blocked: false`);
    }

    expect(
      offenders,
      [
        "Every error path here must resolve to nobody being contacted.",
        "An error means we do not know whether they said no, and not knowing",
        "is not permission. A single verdict fails closed with blocked(...);",
        "a batch filter fails closed with an empty allowed list.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("the queue filter never returns the unfiltered list on failure", () => {
    // Stated separately because it is the one that gets "optimised" — a
    // reviewer sees an empty queue in a broken state and is tempted to make
    // it degrade gracefully. Degrading gracefully here means phoning people
    // who asked us not to.
    const file = sourceFiles.find((f) => f.path === SUPPRESSION_READER)!;
    const filter = file.code.slice(file.code.indexOf("export async function filterContactable"));
    expect(filter).toMatch(/allowed:\s*\[\]/);
    expect(filter).not.toMatch(/allowed:\s*items/);
  });
});

describe("the queue is filtered, not the dial", () => {
  /**
   * BLOCKING AT THE DIAL IS ONE STEP TOO LATE.
   *
   * By then the name and the number are on a screen in front of a person, and
   * a person who can see a number will phone it — from their own handset,
   * outside the CRM, where the block that "worked" recorded nothing and
   * stopped nobody. The refusal has to happen where the LIST is built.
   *
   * So lib/leadAccess.ts is the only module that may read the leads table,
   * and it always filters. This is a heavy rule and it is the right weight:
   * every screen that shows a callable lead is a screen someone can call from.
   */
  const LEAD_READER = "lib/leadAccess.ts";

  /**
   * Queries that assemble CANDIDATES and then hand them to listContactable.
   * They may touch the table because the filter is applied to everything they
   * assemble — adding to such a query can only add to what gets filtered.
   */
  const CANDIDATE_ASSEMBLERS = new Set(["queue.ts", "seed.ts"]);

  test("only lib/leadAccess.ts and the queue assemblers read the leads table", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === LEAD_READER || CANDIDATE_ASSEMBLERS.has(file.path)) continue;
      if (/query\(\s*"leads"/.test(file.code)) {
        offenders.push(`${file.path}: queries leads directly`);
      }
    }
    expect(
      offenders,
      [
        "Lead lists come from listContactable() in convex/lib/leadAccess.ts,",
        "which always applies the suppression filter. A direct query returns",
        "suppressed businesses, and a name on a screen is a name someone can",
        "phone from their own handset — where nothing records it and nothing",
        "stops it.",
        "",
        "If you are assembling candidates to hand to listContactable, add the",
        "file to CANDIDATE_ASSEMBLERS above and make sure the filter is",
        "applied to everything the query assembles.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("every queue assembler actually calls the filter", () => {
    // The allowlist above says "this file may touch leads because it filters".
    // This is the half that checks it does.
    const offenders: string[] = [];
    for (const path of CANDIDATE_ASSEMBLERS) {
      const file = sourceFiles.find((f) => f.path === path);
      if (!file) continue;
      if (!/query\(\s*"leads"/.test(file.code)) continue; // reads none, fine
      if (!/listContactable\(/.test(file.code)) {
        offenders.push(`${path}: reads leads without calling listContactable`);
      }
    }
    expect(
      offenders,
      "A file on the assembler allowlist has stopped filtering. Either call listContactable or take it off the list.",
    ).toEqual([]);
  });

  test("no lead list is returned without the filter having run", () => {
    /*
     * The subtler failure: a query that calls listContactable AND also
     * returns a raw candidate array it built earlier. The filter ran, and the
     * suppressed rows went out anyway beside it.
     */
    const queue = sourceFiles.find((f) => f.path === "queue.ts");
    if (!queue) return;
    for (const chunk of queue.code.split(/export const /).slice(1)) {
      const body = chunk.split(/\nexport /)[0]!;
      if (!/query\(\s*"leads"/.test(body)) continue;
      const name = chunk.match(/^(\w+)/)?.[1] ?? "unknown";
      expect(
        /listContactable\(/.test(body),
        `queue.ts: ${name} reads leads but never filters them`,
      ).toBe(true);
      expect(
        /return\s*\{[^}]*\bcandidates\b/.test(body),
        `queue.ts: ${name} returns the unfiltered candidate array`,
      ).toBe(false);
    }
  });
});

describe("provenance cannot be backfilled", () => {
  /**
   * "Where did you get my number" is a question a stranger is entitled to ask
   * and we are obliged to answer, from the ROW rather than from somebody's
   * memory of which spreadsheet a batch came out of.
   *
   * A provenance written LATER is a guess about the past dressed as a record
   * of it, and the only reason to write one is that the true answer was not
   * kept — which is exactly when a guess is worst.
   */
  test("nothing patches a lead's provenance", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const m of file.code.matchAll(/db\.(patch|replace)\([^;]*?provenance/gs)) {
        offenders.push(`${file.path}: writes provenance after creation (${m[1]})`);
      }
    }
    expect(
      offenders,
      [
        "Provenance is set once, at capture, and never edited. A row whose",
        "origin was not recorded cannot have one reconstructed — delete it and",
        "re-source it if you need it, which is the honest repair.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("it is required by the schema, so a lead cannot exist without it", () => {
    // Optional would mean the rows that most need it — a hurried import, a
    // pasted list — are exactly the ones that would not have it.
    const growth = sourceFiles.find((f) => f.path === "tables/growth.ts");
    expect(growth?.code).toMatch(/provenance:\s*v\.object\(/);
    expect(growth?.code).not.toMatch(/provenance:\s*v\.optional\(/);
  });

  test("it carries the source, the capture time and the lawful basis", () => {
    const growth = sourceFiles.find((f) => f.path === "tables/growth.ts")!;
    const block = growth.code.slice(growth.code.indexOf("provenance: v.object("));
    for (const field of ["source:", "capturedAt:", "lawfulBasis:"]) {
      expect(block.slice(0, 900)).toContain(field);
    }
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
