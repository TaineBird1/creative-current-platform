import { describe, expect, test } from "vitest";
import { duplicateNames, parseLeads } from "./lib/parse-leads";

/**
 * The parser is the part with edge cases, and the edge cases are the ones a
 * real trade-directory paste actually contains: a business whose name has a
 * comma in it, a spreadsheet selection that is tab-separated, a trailing
 * newline.
 *
 * Getting one wrong writes provenance against the wrong business, and
 * provenance is write-once — a guard forbids patching it. So the failures
 * here are permanent rather than annoying.
 */

describe("it takes what a spreadsheet actually produces", () => {
  test("comma-separated with a header", () => {
    const out = parseLeads(
      ["name,phone,area", "Renu Solar,0821234567,Hillcrest", "Alpha Power,0839998888,Ballito"].join("\n"),
    );
    expect(out.error).toBeNull();
    expect(out.rows).toEqual([
      { businessName: "Renu Solar", phone: "0821234567", area: "Hillcrest" },
      { businessName: "Alpha Power", phone: "0839998888", area: "Ballito" },
    ]);
  });

  test("tab-separated, which is what pasting out of Sheets gives you", () => {
    const out = parseLeads("name\tphone\nRenu Solar\t0821234567");
    expect(out.error).toBeNull();
    expect(out.rows).toEqual([{ businessName: "Renu Solar", phone: "0821234567" }]);
  });

  /**
   * THE ONE A PLAIN SPLIT GETS WRONG, silently. The name is truncated at the
   * comma and the remainder becomes a phone number that will not parse, so
   * the row imports with a mangled name and no number and nothing errors.
   */
  test("a quoted field containing the delimiter", () => {
    const out = parseLeads('name,phone\n"Renu Solar, Hillcrest",0821234567');
    expect(out.rows).toEqual([
      { businessName: "Renu Solar, Hillcrest", phone: "0821234567" },
    ]);
  });

  test("a doubled quote inside a quoted field", () => {
    const out = parseLeads('name\n"The ""Big"" Solar Co"');
    expect(out.rows[0]?.businessName).toBe('The "Big" Solar Co');
  });

  test("a trailing newline is not a fault", () => {
    const out = parseLeads("name,phone\nRenu Solar,0821234567\n\n");
    expect(out.rows).toHaveLength(1);
    expect(out.blankLines).toEqual([]);
  });

  test("header aliases, because nobody names the column the same way twice", () => {
    const out = parseLeads("Business Name,Telephone,Suburb,Listing\nRenu Solar,082,Hillcrest,SolarZA");
    expect(out.rows[0]).toEqual({
      businessName: "Renu Solar",
      phone: "082",
      area: "Hillcrest",
      detail: "SolarZA",
    });
  });

  test("columns it does not recognise are named, not silently dropped", () => {
    const out = parseLeads("name,rating,reviews\nRenu Solar,4.8,120");
    expect(out.rows[0]).toEqual({ businessName: "Renu Solar" });
    // Named so the person can see the rating column did not come in — which
    // is correct, since a rating is Google's licensed content and a guard
    // keeps it out of every table but placesCache.
    expect(out.ignoredColumns).toEqual(["rating", "reviews"]);
  });
});

describe("it refuses rather than guessing", () => {
  test("no header means no import", () => {
    const out = parseLeads("Renu Solar,0821234567\nAlpha Power,0839998888");
    expect(out.rows).toEqual([]);
    expect(out.error).toMatch(/business-name column/i);
  });

  test("the refusal explains why guessing is not an option", () => {
    const out = parseLeads("a,b\n1,2");
    expect(out.error).toMatch(/provenance cannot be corrected/i);
  });

  test("empty input", () => {
    expect(parseLeads("").error).toBe("Nothing to import.");
    expect(parseLeads("   \n  ").error).toBe("Nothing to import.");
  });

  test("a line with cells but no name is reported by line number", () => {
    const out = parseLeads("name,phone\nRenu Solar,082\n,0839998888\nAlpha,083");
    expect(out.rows).toHaveLength(2);
    // Findable in the source file, rather than a count of things that vanished.
    expect(out.blankLines).toEqual([3]);
  });
});

describe("duplicates inside one paste are surfaced before the write", () => {
  test("names repeated in the same file", () => {
    const out = parseLeads("name\nRenu Solar\nAlpha Power\nrenu solar");
    expect(duplicateNames(out.rows)).toEqual(["renu solar"]);
  });

  test("a clean list reports none", () => {
    const out = parseLeads("name\nRenu Solar\nAlpha Power");
    expect(duplicateNames(out.rows)).toEqual([]);
  });
});
