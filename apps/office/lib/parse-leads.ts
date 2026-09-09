/**
 * PASTED ROWS, TURNED INTO LEADS.
 *
 * The list arrives from a trade directory as a spreadsheet selection, which
 * means TAB-separated when it comes out of Excel or Sheets and comma-separated
 * when it comes out of a file. Both, then, decided per line rather than
 * configured: asking somebody to pick a delimiter is asking them to get it
 * wrong once and import 200 businesses with their names in one column.
 *
 * IT REFUSES RATHER THAN GUESSING what a column means. A header row is
 * required, because positional columns silently swap `phone` and `website` the
 * first time somebody reorders their spreadsheet, and provenance written
 * against the wrong business cannot be corrected afterwards — `provenance` is
 * write-once and a guard forbids patching it.
 *
 * Parsing lives here, apart from the screen, because it is the part with edge
 * cases and the part worth testing: quoted fields containing the delimiter,
 * a trailing blank line, a business whose name contains a comma.
 */

export type ParsedRow = {
  businessName: string;
  phone?: string;
  website?: string;
  area?: string;
  detail?: string;
  ownerName?: string;
};

export type ParseResult = {
  rows: ParsedRow[];
  /** Header names that were present and not recognised. Reported, not dropped silently. */
  ignoredColumns: string[];
  /** Line numbers (1-based, counting the header) that produced nothing. */
  blankLines: number[];
  error: string | null;
};

/** The only columns that mean anything. Everything else is named and ignored. */
const COLUMNS: Record<string, keyof ParsedRow> = {
  business: "businessName",
  businessname: "businessName",
  name: "businessName",
  company: "businessName",
  phone: "phone",
  telephone: "phone",
  tel: "phone",
  mobile: "phone",
  number: "phone",
  website: "website",
  url: "website",
  web: "website",
  area: "area",
  suburb: "area",
  town: "area",
  city: "area",
  detail: "detail",
  source: "detail",
  listing: "detail",
  owner: "ownerName",
  ownername: "ownerName",
  contact: "ownerName",
};

/**
 * One line into fields, honouring quotes.
 *
 * `"Renu Solar, Hillcrest",0821234567` is two fields, not three. A split on
 * the delimiter gets that wrong and the error is invisible: the name is
 * truncated at the comma and the rest becomes a phone number that will not
 * parse, so the row imports with a mangled name and no number.
 */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === delimiter) {
      out.push(field);
      field = "";
    } else field += char;
  }

  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Tab or comma, decided from the HEADER LINE rather than configured.
 *
 * A spreadsheet selection is tab-separated and a saved file is
 * comma-separated, and the person pasting does not think about which. Counted
 * on the header because it is the one line guaranteed to have every column.
 */
function detectDelimiter(header: string): string {
  return header.split("\t").length > header.split(",").length ? "\t" : ",";
}

export function parseLeads(input: string): ParseResult {
  const lines = input.split(/\r?\n/);
  const firstIndex = lines.findIndex((l) => l.trim() !== "");

  if (firstIndex === -1) {
    return { rows: [], ignoredColumns: [], blankLines: [], error: "Nothing to import." };
  }

  const delimiter = detectDelimiter(lines[firstIndex]!);
  const header = splitLine(lines[firstIndex]!, delimiter).map((h) =>
    h.toLowerCase().replace(/[^a-z]/g, ""),
  );

  const mapped = header.map((h) => COLUMNS[h] ?? null);
  const ignoredColumns = header.filter((h, i) => h !== "" && mapped[i] === null);

  if (!mapped.includes("businessName")) {
    return {
      rows: [],
      ignoredColumns,
      blankLines: [],
      error:
        "No business-name column. The first line must be a header — name, phone, website, area, detail — " +
        "because guessing which column is which writes provenance against the wrong business, and provenance cannot be corrected afterwards.",
    };
  }

  const rows: ParsedRow[] = [];
  const blankLines: number[] = [];

  for (let i = firstIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue; // trailing newline, not a fault

    const cells = splitLine(raw, delimiter);
    const row: ParsedRow = { businessName: "" };

    mapped.forEach((key, index) => {
      if (!key) return;
      const value = cells[index]?.trim();
      if (value) row[key] = value;
    });

    if (!row.businessName) {
      // A line with cells but no name. Named by line number so it can be
      // found in the source, rather than silently dropped.
      blankLines.push(i + 1);
      continue;
    }

    rows.push(row);
  }

  return { rows, ignoredColumns, blankLines, error: null };
}

/**
 * Businesses appearing twice in the SAME paste.
 *
 * The backend dedupes against the table and within the batch, so these are
 * not an error — but they change what "212 rows" means, and somebody about to
 * write permanent provenance should see the real number before they commit
 * rather than infer it from the result afterwards.
 */
export function duplicateNames(rows: ParsedRow[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const row of rows) {
    const key = row.businessName.trim().toLowerCase();
    if (seen.has(key)) twice.add(row.businessName.trim());
    seen.add(key);
  }
  return [...twice];
}
