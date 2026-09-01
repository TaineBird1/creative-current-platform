#!/usr/bin/env node
/**
 * Import the KZN solar campaign list into `leads`.
 *
 * Run:  node scripts/import-kzn-solar.mjs <csv>          # prints the args
 *       node scripts/import-kzn-solar.mjs <csv> --run    # and writes them
 *
 * PRINTS BY DEFAULT, writes only when asked. The exact rows can be read
 * before anything lands, which for an import of real people's phone numbers
 * is worth one extra command.
 *
 * `--run` shells out to `npx convex run` rather than using the HTTP client,
 * because `importLeads` is an internalMutation and the client cannot call
 * one. That is deliberate — guards.test.ts asserts it — since a public bulk
 * lead writer is exactly that.
 *
 * It chunks, for a boring reason with a sharp edge: Windows has a command
 * line length limit and 59 rows of JSON exceeds it. The mutation is
 * idempotent on phone then name, so chunking cannot duplicate a lead and a
 * half-finished run is resumed by running it again.
 *
 * PROVENANCE IS THE POINT OF THIS SCRIPT, not the rows.
 *
 *   source       campaign_list — compiled off trade directories, not Places
 *   capturedAt   the mtime of the ORIGINAL pull, not when this import ran
 *   detail       the specific directory THIS business was listed in
 *
 * `detail` is per row rather than per batch because "from a campaign list" is
 * not an answer to "where did you get my number", and "you are listed on
 * SolarZA, which is where I found you" is. The CSV already carries that in
 * its `source` column and it would be thrown away by a batch-level label.
 *
 * lawfulBasis is legitimate_interest: B2B prospecting to businesses that
 * publish their numbers in trade directories to be contacted for work. That
 * is recorded as a CLAIM, auditable on every row — it is not a finding that
 * any given channel is permitted, and POPIA s69 treats electronic direct
 * marketing more strictly than a phone call.
 */

import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [, , csvPath, ...flags] = process.argv;
const run = flags.includes("--run");
if (!csvPath) {
  console.error("usage: node scripts/import-kzn-solar.mjs <path-to-csv> > args.json");
  process.exit(1);
}

/** Minimal RFC4180 reader — the notes column contains commas and quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const raw = readFileSync(csvPath, "utf8").replace(/^﻿/, "");
const [header, ...lines] = parseCsv(raw);
const col = (name) => header.indexOf(name);

const iCompany = col("company");
const iArea = col("area");
const iSource = col("source");
const iWebsite = col("website");
const iPhone = col("phone");
const iNotes = col("notes");
const iContact = col("contact_person");
const iRole = col("role");
const iEnrich = col("enrich_note");

if (iCompany < 0) {
  console.error("that file has no `company` column — is it the right list?");
  process.exit(1);
}

/*
 * The ORIGINAL pull, not today. The enriched file was rewritten on a later
 * date; the base list beside it is when these businesses were actually
 * collected, and that is the honest answer to "when did you get this".
 */
const originalPull = csvPath.replace(/-enriched\.csv$/, ".csv");
let capturedAt;
try {
  capturedAt = statSync(originalPull).mtimeMs;
} catch {
  capturedAt = statSync(csvPath).mtimeMs;
}

const rows = [];
for (const line of lines) {
  const name = (line[iCompany] ?? "").trim();
  if (!name) continue;

  const area = (line[iArea] ?? "").trim();
  const directory = (line[iSource] ?? "").trim() || "unknown directory";
  const notes = (line[iNotes] ?? "").trim();
  const enrich = (iEnrich >= 0 ? line[iEnrich] : "")?.trim() ?? "";
  const contact = (iContact >= 0 ? line[iContact] : "")?.trim() ?? "";
  const role = (iRole >= 0 ? line[iRole] : "")?.trim() ?? "";

  /*
   * The call note is what a person needs in their ear, so the enrichment
   * note leads: it is the specific observation ("SITE DOWN, verified") that
   * makes an opener, where the generic note is usually filing.
   */
  const isFault = enrich && /down|503|no site|broken|expired|not secure/i.test(enrich);
  // Not repeated. When the enrichment note IS the fault it is already on
  // screen above; saying it twice on a card read at arm's length is noise.
  const callNote = [isFault ? "" : enrich, notes].filter(Boolean).join(" — ") || undefined;

  rows.push({
    businessName: name,
    phone: (line[iPhone] ?? "").trim() || undefined,
    website: (line[iWebsite] ?? "").trim() || undefined,
    detail: area ? `${directory} directory listing (${area})` : `${directory} directory listing`,
    // Not invented. Only what the file actually observed about their web
    // presence — a fault we cannot evidence is a claim on a cold call.
    auditFaults: isFault ? [enrich.length > 90 ? `${enrich.slice(0, 87)}…` : enrich] : [],
    callNote,
    ownerName: contact || undefined,
    // The names came from an email address or a site's about page, not from
    // the person. Never "high" — opening with the wrong name is worse than
    // opening with none, and the screen shows the hedge.
    ownerNameConfidence: contact ? "low" : undefined,
    ownerNameSource: contact ? role || "enrichment pass" : undefined,
  });
}

const ventureId = process.env.VENTURE_ID;
if (!ventureId) {
  console.error("set VENTURE_ID to the venture these leads belong to");
  process.exit(1);
}

// Counts to stderr so stdout stays clean JSON for the convex CLI.
console.error(`${rows.length} rows from ${csvPath}`);
console.error(`captured ${new Date(capturedAt).toISOString().slice(0, 10)} (original pull)`);
console.error(`${rows.filter((r) => r.phone).length} have a number and will reach the queue`);

const base = {
  ventureId,
  niche: "solar",
  source: "campaign_list",
  lawfulBasis: "legitimate_interest",
  capturedAt,
};

if (!run) {
  process.stdout.write(JSON.stringify({ ...base, rows }, null, 2));
  console.error("\ndry run — pass --run to write");
  process.exit(0);
}

/*
 * The CLI's own entry point, run through node directly. `npx` on Windows is
 * a .cmd shim, which execFileSync cannot spawn without a shell — and a shell
 * is what mangles the JSON quoting in the first place.
 */
const CONVEX_CLI = new URL("../node_modules/convex/bin/main.js", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);

const CHUNK = 8;
const totals = { created: 0, skipped: 0, withoutPhone: 0 };

for (let i = 0; i < rows.length; i += CHUNK) {
  const args = JSON.stringify({ ...base, rows: rows.slice(i, i + CHUNK) });
  /*
   * execFileSync with an args ARRAY and no shell. Passing this through a
   * shell loses the quoting on Windows — PowerShell strips it and the CLI
   * receives something that is not JSON.
   */
  const out = execFileSync(
    process.execPath,
    [CONVEX_CLI, "run", "leadImport:importLeads", args],
    { encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(out.slice(out.indexOf("{")));
  totals.created += parsed.created;
  totals.skipped += parsed.skipped;
  totals.withoutPhone += parsed.withoutPhone;
  console.error(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
}

console.error(
  `created ${totals.created}, skipped ${totals.skipped} already present, ` +
    `${totals.withoutPhone} with no number (they will not appear in the call queue)`,
);
