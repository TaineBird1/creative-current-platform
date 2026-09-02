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

  /**
   * `book` was split into a tenant wrapper and `createBooking` when the first
   * non-browser caller appeared. The split is only safe while there is exactly
   * ONE function doing the work — a second caller that reimplements the
   * overlap check, the 24-hour cap or the in-transaction confirmation gets a
   * booking that looks identical and obeys different rules.
   *
   * The insert itself is already pinned to this file by the test above. This
   * pins the ENTRY POINT, so a caller reaching past createBooking has to say
   * why here.
   */
  test("every caller books through createBooking, not around it", () => {
    const CALLERS = new Set(["bookings.ts", "onboarding.ts"]);
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      if (CALLERS.has(file.path)) continue;
      if (/createBooking\(/.test(file.code)) {
        offenders.push(`${file.path}: calls createBooking directly`);
      }
    }

    // And the one that does must not have grown a second implementation.
    const bookings = sourceFiles.find((f) => f.path === STARTS_AT_WRITER);
    const inserts = [...(bookings?.code ?? "").matchAll(/db\.insert\(\s*"bookings"/g)].length;

    expect(inserts, "bookings.ts inserts a booking in more than one place").toBe(1);
    expect(
      offenders,
      [
        "A booking is created by createBooking in convex/bookings.ts. It is",
        "where the overlap guarantee, the 24-hour cap and the confirmation",
        "queued in the same transaction all live. A second entry point gets a",
        "booking that looks identical and obeys different rules.",
        "",
        "If you are adding a caller — a public booking form, an import — add it",
        "to CALLERS above and say why it is safe.",
      ].join("\n"),
    ).toEqual([]);
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

  /**
   * NEVER A LEAD.
   *
   * The demo/seed block catches data we made up. This catches data that is
   * entirely real and must still never be messaged: a business we are
   * prospecting. `isDemo` and `isSeed` are DESIGNATIONS, and no honest one
   * exists for a lead — which is precisely why the gap was there.
   *
   * A test rather than a comment because the failure is silent and arrives as
   * an automated email to a stranger, on a cron.
   */
  test("dispatch checks the recipient against the lead list", () => {
    const messaging = sourceFiles.find((f) => f.path === DISPATCH);
    expect(
      /recipientIsLead\(/.test(messaging?.code ?? ""),
      [
        "convex/lib/messaging.ts must call recipientIsLead before queueing.",
        "Outreach in this business is drafted and sent by hand. A transactional",
        "pipeline that can reach a prospect is an outreach channel whether or",
        "not anyone meant to build one — and this one sends on a cron.",
      ].join("\n"),
    ).toBe(true);
  });

  /**
   * A TRIPWIRE, in the same shape as the messageRevision one above, and for
   * the same reason: it guards something that does not exist yet, so a note
   * would be read by nobody at the moment it mattered.
   *
   * `contacts` holds a named person at a company, and a company hangs off a
   * LEAD. Nothing writes it today, so `recipientIsLead` does not read it and
   * is complete as it stands. The day something does write it, a lead's
   * contact details exist in a second table that the lead check has never
   * heard of — and the check would go on passing, quietly, for every one of
   * them.
   *
   * So: whoever adds the writer has to extend the check in the same change.
   * The failure this prevents is an automated email to a named person at a
   * business we are prospecting, which is the worst message this system could
   * possibly send.
   */
  test("nothing writes the contacts table until the lead check reads it too", () => {
    const writers = sourceFiles
      .filter((f) => /db\.(insert|patch|replace)\(\s*"contacts"/.test(f.code))
      .map((f) => f.path);

    const leadAccess = sourceFiles.find((f) => f.path === "lib/leadAccess.ts");
    const checkReadsContacts = /query\(\s*"contacts"/.test(leadAccess?.code ?? "");

    expect(
      writers.length === 0 || checkReadsContacts,
      [
        `contacts is now written by: ${writers.join(", ")}`,
        "",
        "A `contacts` row is a named person at a company, and a company hangs",
        "off a LEAD. recipientIsLead in convex/lib/leadAccess.ts checks lead",
        "phones and lead websites and knows nothing about this table — so every",
        "contact in it is reachable by the transactional pipeline, silently.",
        "",
        "Extend recipientIsLead to read contacts in this same change, then this",
        "passes. An automated booking email to a named person at a business we",
        "are prospecting is the worst message this system can send.",
      ].join("\n"),
    ).toBe(true);
  });

  /**
   * `recipientIsLead` SKIPS a phone it cannot canonicalise rather than
   * blocking on it, because lead phones are stored as E.164 and an unreadable
   * number cannot match one. That is only safe while `contactDecision` — which
   * fails closed on exactly that input — still runs on every dispatch.
   *
   * Two checks that lean on each other, so removing either has to fail here
   * rather than in production.
   */
  test("and still runs the suppression check, which the lead check leans on", () => {
    const messaging = sourceFiles.find((f) => f.path === DISPATCH);
    expect(
      /contactDecision\(/.test(messaging?.code ?? ""),
      [
        "convex/lib/messaging.ts must still call contactDecision.",
        "recipientIsLead skips a phone it cannot normalise, on the grounds that",
        "contactDecision refuses it a few lines later. Remove that and an",
        "unreadable number is checked by nothing at all.",
      ].join("\n"),
    ).toBe(true);
  });

  /**
   * THE SEND ALLOWLIST IS APPLIED IN ONE PLACE.
   *
   * `driverFor` wraps every driver that can actually send, rather than each
   * driver checking for itself. A WhatsApp driver added later is then gated on
   * the day it is written, not the day somebody remembers — which is the whole
   * reason the wrapper is at the factory and not inside `resendEmail`.
   */
  test("every live driver is wrapped in the send allowlist", () => {
    const providers = sourceFiles.find((f) => f.path === "lib/providers.ts");
    const factory = providers!.code.slice(providers!.code.indexOf("export function driverFor"));
    const body = factory.split("\n}")[0]!;

    expect(
      /gated\(/.test(body),
      [
        "driverFor in convex/lib/providers.ts must wrap live drivers in gated().",
        "A driver that gates itself is a driver the next one will forget to",
        "copy, and the thing being guarded is a live provider pointed at a",
        "database of real people.",
      ].join("\n"),
    ).toBe(true);
  });

  /**
   * THE QUIET-HOURS EXEMPTION IS DECLARED ONCE, AND EXPIRES.
   *
   * Two halves, and both have to hold or the exemption is worse than not
   * having one.
   *
   * The LIST decides by message type and defaults to quiet, so a type nobody
   * thought about is the polite one. A second list elsewhere — or a caller
   * setting the deadline itself — is how "reminders are exempt too, just this
   * once" happens.
   *
   * The WINDOW is what stops it being a licence. A drain that was down comes
   * back at 03:00 and finds a hundred confirmations still exempt by type; only
   * the expiry keeps them from all going out at once.
   */
  test("only lib/messaging.ts decides what may interrupt quiet hours", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === DISPATCH) continue;
      // `quietHoursExemptUntil: v.optional(...)` in the schema DECLARES the
      // column; it does not decide anything. Setting it to a value is the act
      // this rule is about.
      const sets = [...file.code.matchAll(/quietHoursExemptUntil:\s*(\w+)/g)].some(
        (m) => m[1] !== "v",
      );
      if (sets || /INTERRUPTS_QUIET_HOURS/.test(file.code)) {
        offenders.push(`${file.path}: sets or redeclares the quiet-hours exemption`);
      }
    }

    expect(
      offenders,
      [
        "The list of message types that may interrupt quiet hours, and the",
        "deadline derived from it, live in convex/lib/messaging.ts and nowhere",
        "else. A caller that can set its own exemption can exempt anything —",
        "which is how a reminder ends up on somebody's phone at 03:00.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("and the exemption always expires", () => {
    const messaging = sourceFiles.find((f) => f.path === DISPATCH);
    const code = messaging?.code ?? "";

    // A window constant, and a deadline built from the event rather than a
    // bare boolean returned from the list.
    expect(
      /INTERRUPT_WINDOW_MS\s*=/.test(code),
      "convex/lib/messaging.ts must define a window the exemption expires after.",
    ).toBe(true);
    expect(
      /triggeredAt \+ INTERRUPT_WINDOW_MS/.test(code),
      [
        "The exemption must be anchored to WHEN THE EVENT HAPPENED, not to the",
        "message type alone. Without that, a drain recovering at 03:00 sends",
        "every queued confirmation at once — the exact intrusion quiet hours",
        "exist to prevent, arriving through the door built to allow one",
        "exception.",
      ].join("\n"),
    ).toBe(true);
  });

  /**
   * The other half of the choke point, added the day a real driver arrived.
   *
   * CREATING a message is guarded above. RESOLVING one — claiming it was sent,
   * or that it failed — is the write that makes the outbox lie if anything
   * else can do it. The outbox is the only screen that answers "did they hear
   * from us", and it answers out of these four statuses.
   */
  test("only lib/messaging.ts marks a message sent, failed or in flight", () => {
    const SEND_STATES = /status:\s*"(sending|sent|delivered|failed)"/g;
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      if (file.path === DISPATCH) continue;
      /*
       * Only files that handle messages at all. `sent` is not a word this
       * codebase reserves — a QUOTE is sent too, and quotes.ts writing
       * `status: "sent"` on a quote is not this rule's business. Narrowing on
       * the table keeps the guard aimed at the thing it is about rather than
       * at a word.
       */
      if (!/"messages"|Id<"messages">/.test(file.code)) continue;
      for (const m of file.code.matchAll(SEND_STATES)) {
        offenders.push(`${file.path}: writes status "${m[1]}"`);
      }
    }

    expect(
      offenders,
      [
        "Only convex/lib/messaging.ts may move a message towards sent or",
        "failed. That is where the claim is serializable, where a stalled send",
        "is requeued rather than abandoned, and where attempts are counted.",
        "A second writer can mark a message sent that nobody received, and the",
        "outbox would agree with it.",
      ].join("\n"),
    ).toEqual([]);
  });

  /**
   * THE ONE THAT MATTERS MOST HERE.
   *
   * WhatsApp has no provider yet, so it has a no-op driver. The tempting shape
   * for a no-op is one that returns success: it keeps the pipeline green and
   * every screen reads as working. It would also stamp `sent` on rows nobody
   * received, which is the invisible failure this codebase spends most of its
   * rules avoiding. The no-op logs, and refuses.
   *
   * Whoever wires WhatsApp deletes the no-op rather than making it agreeable.
   */
  test("the no-op driver never claims a message was delivered", () => {
    const providers = sourceFiles.find((f) => f.path === "lib/providers.ts");
    expect(providers, "convex/lib/providers.ts has moved or been removed").toBeDefined();

    const from = providers!.code.indexOf("function loggingNoop");
    expect(from, "loggingNoop has been renamed — update this guard").toBeGreaterThan(-1);
    const body = providers!.code.slice(from).split("\n}")[0]!;

    expect(
      /delivered:\s*false/.test(body),
      [
        "The no-op driver in convex/lib/providers.ts must report a refusal, not",
        "a delivery. A no-op that returns delivered:true marks messages sent",
        "that nobody received — and the outbox, the only place anyone can",
        "check, would say the customer was told.",
      ].join("\n"),
    ).toBe(true);
    expect(/delivered:\s*true/.test(body)).toBe(false);
  });

  /**
   * Consent rows are evidence. Two writers is two opinions about what a
   * customer agreed to, and the one that decides is whichever ran last.
   *
   *   - customers.ts : a staff member recording one by hand
   *   - messages.ts  : a booking establishing a CONTRACT basis where no row
   *                    exists at all, which by construction cannot overturn a
   *                    withdrawal
   */
  test("only two modules write a consent row", () => {
    const CONSENT_WRITERS = new Set(["customers.ts", "messages.ts"]);
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      if (CONSENT_WRITERS.has(file.path)) continue;
      if (/db\.insert\(\s*"consents"/.test(file.code)) {
        offenders.push(`${file.path}: inserts a consent row`);
      }
    }

    expect(
      offenders,
      [
        "A consent row is evidence of what a customer agreed to. It is written",
        "by customers.recordConsent (a person recording one) and by",
        "messages.establishTransactionalConsent (a booking establishing a",
        "contract basis where NO row exists). Anything else is a third opinion",
        "about who may be contacted.",
      ].join("\n"),
    ).toEqual([]);
  });

  /**
   * `bookings.by_start` spans every client, because the reminder sweep is a
   * platform cron asking "what starts in about 24 hours" without knowing whose
   * booking it is. That is exactly the shape tenancy exists to prevent
   * everywhere else: a query that does not restate its own clientId.
   */
  test("the cross-tenant bookings index is not reachable from tenant code", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      if (!/withIndex\(\s*"by_start"/.test(file.code)) continue;
      if (/tenant(Query|Mutation)\s*\(/.test(file.code)) {
        offenders.push(`${file.path}: uses by_start beside tenant-scoped functions`);
      }
    }

    expect(
      offenders,
      [
        "bookings.by_start reads across every client. It exists for the",
        "reminder cron, which has no tenant. A tenant-scoped function must use",
        "by_client_start, or it can read another client's calendar.",
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

describe("invoice numbering", () => {
  /**
   * THE BOUNDARY THAT USED TO BE HERE IS GONE, AND WHY MATTERS.
   *
   * This block previously asserted that NOTHING writes the invoices table,
   * on the reasoning that an invoice needs a registered entity and none
   * existed. That was half wrong. It is true of a Pty Ltd, which takes weeks
   * at CIPC — and false of a SOLE PROPRIETOR, who invoices in their own name
   * and has nothing to register. The schema had it right all along:
   * `issuerRegistrationNumber` was already optional. The guard did not.
   *
   * What survives is the rule that actually governs numbering, below.
   */

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
     * WHAT THIS USED TO MISS, found while building invoicing. It scanned only
     * the chunks AFTER the first `export const`, so a counter helper defined
     * above the exports was invisible — which is exactly where such a helper
     * lives. `quotes.ts` has had one since it was written and this passed
     * anyway. It now follows the CALLS, because the call site is where the
     * transaction boundary actually is.
     */
    const offenders: string[] = [];
    /** Tables whose rows consume a number from `invoiceCounters`. */
    const NUMBERED = ["quotes", "invoices"];
    /** Helpers that take a number. Calling one counts as touching the counter. */
    const TAKERS = /\b(takeNumber|nextNumber)\s*\(/;

    for (const file of sourceFiles) {
      if (!/invoiceCounters/.test(file.code) && !TAKERS.test(file.code)) continue;

      // Per exported function, so "same file" is not mistaken for "same
      // transaction" — two mutations in one file are still two transactions.
      for (const chunk of file.code.split(/export const /).slice(1)) {
        const body = chunk.split(/\nexport /)[0]!;
        const name = chunk.match(/^(\w+)/)?.[1] ?? "unknown";

        const takesNumber =
          /db\.(patch|replace|insert)\([^;]*invoiceCounter/s.test(body) ||
          /query\(\s*"invoiceCounters"/.test(body) ||
          TAKERS.test(body);
        if (!takesNumber) continue;

        const insertsNumbered = NUMBERED.some((table) =>
          new RegExp(`db\\.insert\\(\\s*"${table}"`).test(body),
        );
        if (!insertsNumbered) {
          offenders.push(`${file.path}: ${name} takes a number without inserting the row for it`);
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

  test("an issued invoice is never deleted, only voided", () => {
    /*
     * Deleting leaves a gap that looks like a MISSING invoice rather than a
     * cancelled one, and an accountant cannot tell those apart from outside.
     * Voiding keeps the number used and the document visible, with a
     * reversing ledger entry beside it.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (/db\.delete\([^)]*invoice/i.test(file.code)) {
        offenders.push(`${file.path}: deletes an invoice`);
      }
    }
    expect(offenders, "Void it instead — the record has to stay.").toEqual([]);
  });

  test("the issuer is snapshotted onto the invoice, never joined at read time", () => {
    /*
     * A person who converts to a Pty Ltd, or corrects their trading name,
     * must not silently rewrite documents already in clients' inboxes. What
     * was true on the day is what the invoice says forever.
     */
    const invoices = sourceFiles.find((f) => f.path === "invoices.ts");
    if (!invoices) return;
    expect(invoices.code).toMatch(/issuerLegalName:\s*issuer\.legalName/);

    const get = invoices.code.slice(invoices.code.indexOf("export const get"));
    expect(
      /query\(\s*"issuers"/.test(get),
      "invoices.get must not look the issuer up — the invoice already carries it",
    ).toBe(false);
  });

  test("the payment reference is DERIVED from the number, never stored beside it", () => {
    /*
     * South African clients pay by EFT and the reference is how a deposit
     * finds its invoice. A stored `paymentReference` column could be set to
     * something other than the number — which throws nothing, fails no test,
     * and produces a deposit that reconciles to nothing while both fields
     * look perfectly reasonable in the database.
     *
     * Two fields that are supposed to agree are two fields that will not.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (!file.path.startsWith("tables/")) continue;
      if (/paymentReference:\s*v\./.test(file.code)) {
        offenders.push(`${file.path}: stores a payment reference`);
      }
    }
    expect(
      offenders,
      "The reference IS the invoice number. Derive it — see paymentReference() in invoices.ts.",
    ).toEqual([]);
  });

  test("and every invoice read hands it over rather than leaving it to be worked out", () => {
    // A template that has to derive the reference is a template that can
    // print something else next to the bank details.
    const invoices = sourceFiles.find((f) => f.path === "invoices.ts");
    if (!invoices) return;
    expect(invoices.code).toMatch(/paymentReference:\s*paymentReference\(/);
  });

  test("settlement is derived, never patched onto the invoice", () => {
    /*
     * `recordPayment` used to patch the row to "paid" once the money covered
     * it. A stamped flag for something the ledger already knows can come
     * apart from it: post a refund afterwards and the invoice is still
     * stamped paid, which throws nothing and reads as settled forever.
     *
     * The stored `status` now carries only what a PERSON decides — issued,
     * void, written_off. Paid, part-paid, overpaid and overdue are all
     * computed from money and from today.
     */
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const m of file.code.matchAll(/db\.patch\([^;]*status:\s*"(paid|overdue|draft)"/gs)) {
        offenders.push(`${file.path}: patches an invoice to "${m[1]}"`);
      }
      if (/db\.patch\([^;]*paidAt:/s.test(file.code)) {
        offenders.push(`${file.path}: writes paidAt`);
      }
    }
    expect(
      offenders,
      [
        "Settlement comes from settlementOf() in invoices.ts, which reads the",
        "ledger. A part payment must read as part paid — not as settled, which",
        "stops anyone chasing the rest, and not as untouched, which chases a",
        "client for money they have mostly already sent.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("the balance nets refunds, not just payments", () => {
    // Derived from the wrong set has the same effect as a stamped flag: a
    // settled invoice that was refunded still reads settled.
    const invoices = sourceFiles.find((f) => f.path === "invoices.ts");
    if (!invoices) return;
    const fn = invoices.code.slice(invoices.code.indexOf("async function paidAgainst"));
    expect(fn.slice(0, 600)).toMatch(/"refund"/);
  });

  test("no VAT is charged while there is no VAT number", () => {
    // Charging VAT you are not registered for is worse than not charging it:
    // the money is not yours and SARS wants it either way.
    const invoices = sourceFiles.find((f) => f.path === "invoices.ts");
    if (!invoices) return;
    expect(invoices.code).toMatch(/taxFlag\s*=\s*Boolean\(issuer\.vatNumber\)/);
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

  /**
   * Reads leads WITHOUT returning any, and so cannot put a suppressed name on
   * a screen. `leadImport` scans for duplicates and returns counts.
   *
   * A narrower exemption than the assemblers, with its own condition below:
   * these must be unreachable from a browser at all. "It only returns counts"
   * is a promise about today's code; "it is an internalMutation" is a
   * property the next person cannot quietly change without noticing.
   */
  const INTERNAL_DEDUPE = new Set(["leadImport.ts"]);

  test("dedupe readers are unreachable from a browser", () => {
    const offenders: string[] = [];
    for (const path of INTERNAL_DEDUPE) {
      const file = sourceFiles.find((f) => f.path === path);
      if (!file) continue;
      for (const m of file.code.matchAll(/export\s+const\s+(\w+)\s*=\s*(\w+)\s*\(/g)) {
        if (!/^internal(Query|Mutation|Action)$/.test(m[2]!)) {
          offenders.push(`${path}: ${m[1]} is ${m[2]}, not internal`);
        }
      }
    }
    expect(
      offenders,
      "A file on the dedupe allowlist reads leads without filtering. It is only safe while nothing in a browser can call it.",
    ).toEqual([]);
  });

  test("only lib/leadAccess.ts and the queue assemblers read the leads table", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === LEAD_READER || CANDIDATE_ASSEMBLERS.has(file.path)) continue;
      if (INTERNAL_DEDUPE.has(file.path)) continue;
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

describe("one phone normaliser", () => {
  /**
   * THE PHONE IS A SUPPRESSION KEY, so two opinions about its canonical form
   * is two opinions about who may be called.
   *
   * There WERE two. The importer produced "+27833176385" and the suppression
   * matcher produced "833176385". They agreed only because both sides were
   * normalised again at compare time, so the divergence was latent rather
   * than harmless — one import path storing a raw "083 317 6385" and a
   * suppressed number is back on the queue with every test still green.
   *
   * That is the failure this file cares about most: no error, no red test,
   * and the person who asked not to be called gets called.
   */
  const PHONE = "lib/phone.ts";

  test("nothing else strips digits out of a phone number", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === PHONE) continue;
      // The shape of a hand-rolled normaliser: throwing away non-digits from
      // something the surrounding code calls a phone.
      for (const chunk of file.code.split(/\n(?=\s*(?:export )?(?:async )?function |\n)/)) {
        if (!/phone/i.test(chunk)) continue;
        if (/replace\(\s*\/\\D\/g/.test(chunk) || /replace\(\s*\/\[^0-9\]\/g/.test(chunk)) {
          offenders.push(`${file.path}: normalises a phone number itself`);
          break;
        }
      }
    }
    expect(
      offenders,
      [
        "Use toE164() from convex/lib/phone.ts. It is the one definition of",
        "what a phone number IS here, and the phone is the key suppression",
        "matches on. A second normaliser does not have to be wrong to be",
        "dangerous — it only has to disagree, once, on one import path.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("the suppression key is written through it, not raw", () => {
    // disposition writes the value a future import will be matched against.
    // Writing lead.phone directly works only while every writer normalises.
    const queue = sourceFiles.find((f) => f.path === "queue.ts");
    expect(queue?.code).toMatch(/toE164\(/);
    expect(
      /kind:\s*"phone",\s*value:\s*lead\.phone\b/.test(queue?.code ?? ""),
      "queue.ts writes a raw lead.phone as a suppression value — normalise it first.",
    ).toBe(false);
  });

  test("a customer we cannot message is TOLD, at the moment they give it", () => {
    /**
     * The silent failure this closes. A number that does not reach E.164
     * cannot be checked against the do-not-call list, so dispatch suppresses
     * every message to it — correctly. But the outbox row explaining that is
     * visible to the BUSINESS, and the customer sees nothing: they submit,
     * the confirmation is dropped, and they wait for a message that was never
     * going to arrive.
     *
     * Exactly the demo-form shape, and it gets the same answer. The backend
     * knows at submission time, so the backend says so.
     */
    const quote = sourceFiles.find((f) => f.path === "public/quote.ts");
    expect(quote, "convex/public/quote.ts is missing").toBeTruthy();
    expect(
      /toE164\(/.test(quote!.code),
      "public/quote.ts must decide whether the number it just took can be messaged.",
    ).toBe(true);
    expect(
      /reachable/.test(quote!.code),
      "and it must return that, so the form can say it at the time.",
    ).toBe(true);

    // Staff-side capture too: the person typing it is the only one who can
    // still ask for a different number, and only if they are told now.
    const customers = sourceFiles.find((f) => f.path === "customers.ts");
    expect(customers?.code).toMatch(/reachable/);
  });

  test("an unreachable number does not lose the enquiry", () => {
    // Refusing the number would turn a messaging limitation into a lost
    // booking, which is worse for everyone. It is recorded, and said.
    const quote = sourceFiles.find((f) => f.path === "public/quote.ts")!;
    expect(
      /throw rejected\([^)]*reachab/i.test(quote.code),
      "an unmessageable number must not be rejected — record it and say so",
    ).toBe(false);
  });

  test("an unparseable number is a refusal, not a pass", () => {
    const phone = sourceFiles.find((f) => f.path === PHONE);
    expect(phone, "convex/lib/phone.ts is missing").toBeTruthy();
    // toE164 must be able to say no. A normaliser that always returns
    // something turns a typo into a number that matches nothing.
    expect(phone!.code).toMatch(/e164:\s*null/);
  });
});

describe("the queue only contains callable rows", () => {
  test("leads with no number are filtered out, not rendered dead", () => {
    /*
     * A row you tap dial on where nothing happens teaches you that the dial
     * button is sometimes a lie, and three of those in a morning is enough to
     * stop trusting the screen. They go to `needsNumber` instead — finding a
     * number is research, and research does not belong between two calls.
     */
    const queue = sourceFiles.find((f) => f.path === "queue.ts");
    expect(queue?.code).toMatch(/callable\s*=\s*leads\.filter\(/);
    expect(queue?.code).toMatch(/needsNumberCount/);
    expect(queue?.code).toMatch(/export const needsNumber/);
  });

  test("the needs-a-number list is suppression-filtered too", () => {
    // A business that asked not to be contacted should not appear on a list
    // of people to go and find a number for either.
    const queue = sourceFiles.find((f) => f.path === "queue.ts")!;
    const block = queue.code.slice(queue.code.indexOf("export const needsNumber"));
    const body = block.slice(0, block.indexOf("\nexport const"));
    expect(body).toMatch(/listContactable\(/);
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
  /**
   * Files permitted to write the sites table, each because it parses the
   * config through Zod first — which is the rule. "One writer" was the proxy
   * for it, and the proxy became wrong the moment a second legitimate writer
   * appeared (the demo builder, which generates a config from a template and
   * parses it exactly as siteConfigs does).
   *
   * The condition is asserted below rather than trusted, so this list cannot
   * quietly become a way out.
   */
  const SITE_WRITERS = new Set([SITE_CONFIG_WRITER, "demos.ts"]);

  test("every writer of the sites table parses the config through Zod first", () => {
    // The config column is v.any(), so the database will store anything. The
    // parse is the only thing standing between that and a render-time crash
    // on a page a prospect just opened.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const writes =
        /db\.insert\(\s*"sites"/.test(file.code) ||
        /db\.(patch|replace)\(\s*site(Id|\._id)/.test(file.code);
      if (!writes) continue;

      if (!SITE_WRITERS.has(file.path)) {
        offenders.push(`${file.path}: writes sites but is not an approved writer`);
        continue;
      }
      if (!/safeParseSiteConfig\(|parseSiteConfig\(/.test(file.code)) {
        offenders.push(`${file.path}: writes sites without parsing the config`);
      }
    }
    expect(
      offenders,
      [
        "SiteConfig is stored as v.any(). Every writer must parse it through Zod",
        "before writing — that parse is the schema, and a config that only fails",
        "at render time fails on a page somebody is looking at.",
        "",
        "If you are adding a writer, add it to SITE_WRITERS and parse the config.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("a demo is never written without an expiry", () => {
    /*
     * The resolver refuses to serve a demo with no `demoExpiresAt`, so one
     * created without it is a page that never loads rather than a leak. That
     * is the correct failure and still a bug — and the version of it that
     * matters is a demo built by a future path that forgets, on a page
     * carrying a real business's name.
     */
    const demos = sourceFiles.find((f) => f.path === "demos.ts");
    if (!demos) return;
    const insert = demos.code.slice(demos.code.indexOf('db.insert("sites"'));
    expect(insert.slice(0, 800)).toMatch(/demoExpiresAt:/);
    expect(insert.slice(0, 800)).toMatch(/isDemo:\s*true/);
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

describe("the pipeline", () => {
  /**
   * A deal's probability is what makes the forecast a number rather than a
   * mood. It is derived from the stage in deals.ts and must not be settable
   * from anywhere — including, especially, a form that lets an optimistic
   * afternoon raise it.
   */
  test("probability is never taken from a caller", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const m of file.text.matchAll(/args:\s*\{([\s\S]*?)\n {2}\},/g)) {
        if (/probability:\s*v\./.test(m[1]!)) {
          offenders.push(`${file.path}: accepts probability as an argument`);
        }
      }
    }
    expect(
      offenders,
      "Probability is derived from the stage in deals.ts. A forecast whose inputs can be nudged is a mood, not a number.",
    ).toEqual([]);
  });

  /**
   * `openDeal` is what makes "one open deal per lead" true. A direct insert
   * bypasses it, and two rows for one conversation double the forecast — the
   * exact failure the whole module is shaped to avoid.
   */
  test("only deals.ts inserts into the deals table", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file.path === "deals.ts") continue;
      if (/db\.insert\(\s*"deals"/.test(file.text)) {
        offenders.push(`${file.path}: inserts a deal directly`);
      }
    }
    expect(
      offenders,
      "Use openDeal() from deals.ts. It is what enforces one open deal per lead.",
    ).toEqual([]);
  });

  /**
   * Won means they said yes. Converted means a client exists. Nothing may
   * mark a lead converted without minting one, or the funnel's last column
   * fills with rows that have nothing behind them.
   */
  test("a lead is never marked converted without a client", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      // Line by line, so a COMMENT explaining why we do not do this is not
      // itself reported as doing it — which is exactly what caught deals.ts
      // when this guard was first written.
      const lines = file.text.split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!/status:\s*"converted"/.test(line)) return;
        const around = lines.slice(Math.max(0, i - 8), i + 8).join("\n");
        if (!/convertedClientId/.test(around)) {
          offenders.push(`${file.path}:${i + 1}: sets status "converted" with no client alongside it`);
        }
      });
    }
    expect(
      offenders,
      "A lead marked converted with no client behind it makes every downstream count wrong, in the direction that flatters us.",
    ).toEqual([]);
  });
});
