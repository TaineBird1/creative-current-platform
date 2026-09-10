// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test, expect } from "vitest";
import { expectAbsent } from "../../test-support/negative";

/**
 * THE CLIENT'S BACK OFFICE NAMES NO TRADE.
 *
 * `/c/<slug>` is white-labelled: tinted with the client's own accent, carrying
 * their name, and read by them as THEIR software. Every word of copy in it is
 * therefore copy they attribute to us — and a word from somebody else's
 * industry says, plainly, that this was built for a different customer and
 * handed on.
 *
 * Found in the wild rather than reasoned about. The quote builder's line-item
 * placeholder read "8kW inverter, supplied and fitted" — perfectly sensible
 * when the only client was a solar installer, and shown unchanged to a travel
 * company pricing a holiday, who noticed immediately.
 *
 * IT WILL HAPPEN AGAIN, WHICH IS WHY THIS EXISTS. The first niche template is
 * solar/trades and guest houses are next, so whoever builds that one writes
 * "double room, two nights" into a field with exactly the same good intentions
 * — and every solar client then reads a hotel booking on their own screen.
 * The registry stays generic; so must the chrome around it.
 *
 * WHAT IS BANNED IS NICHE VOCABULARY, NOT PARTICULAR STRINGS. The list below
 * is necessarily incomplete — no wordlist catches an industry nobody has
 * thought of — so it is a tripwire for the CLASS rather than a proof of
 * absence. It earns its place by catching the two niches that actually exist.
 *
 * COMMENTS ARE STRIPPED, and here that cuts the opposite way from every other
 * guard in this repo: usually prose causes a false NEGATIVE by satisfying a
 * rule the code does not. Here the paragraph above, and the one now sitting
 * beside the fixed placeholder, would both be false POSITIVES. Same remedy.
 */

const CLIENT_WORLD = [
  join(__dirname, "app", "c"),
  /* Shared components render inside the client world too. */
  join(__dirname, "components"),
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(): Array<{ file: string; code: string }> {
  const found: Array<{ file: string; code: string }> = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      /* `.tsx` AND `.ts` — a walker that collects one extension in a tree of
         the other is how three guards here scanned nothing and passed. */
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push({ file: relative(__dirname, path), code: stripComments(readFileSync(path, "utf8")) });
      }
    }
  };

  for (const root of CLIENT_WORLD) walk(root);
  return found;
}

const FILES = sourceFiles();

/**
 * Word-bounded, and every one chosen so it cannot collide with the vocabulary
 * of a user interface. `panel` was a candidate and is excluded: `HandoverPanel`
 * and `.panel` are real, correct names here, and a rule that fires on them is
 * a rule somebody deletes.
 */
const NICHE_WORDS: Array<{ pattern: RegExp; provenBy: string }> = [
  { pattern: /\bsolar\b/i, provenBy: 'placeholder="solar geyser service"' },
  { pattern: /\binverter/i, provenBy: 'placeholder="8kW inverter, supplied and fitted"' },
  { pattern: /\bgeyser/i, provenBy: 'placeholder="geyser replacement"' },
  { pattern: /\bborehole/i, provenBy: 'placeholder="borehole pump"' },
  { pattern: /\b\d+\s?kW\b/, provenBy: 'placeholder="8kW inverter, supplied and fitted"' },
  { pattern: /\bguest ?house/i, provenBy: 'placeholder="guesthouse, two nights"' },
  { pattern: /\bper night\b/i, provenBy: 'placeholder="double room, per night"' },
];

describe("the client back office speaks no industry", () => {
  test("the walk found the screens, and names them", () => {
    const files = FILES.map((f) => f.file.replace(/\\/g, "/"));
    /*
     * NAMED, not merely counted. The quote builder is the file the defect was
     * in, so a walk that cannot see it proves nothing about anything.
     */
    expect(
      files.some((f) => f.includes("quotes/QuoteBuilder.tsx")),
      "the walk missed the quote builder, so its verdict is empty",
    ).toBe(true);
    expect(FILES.length).toBeGreaterThan(5);
  });

  for (const { pattern, provenBy } of NICHE_WORDS) {
    test(`no ${pattern} anywhere in the client world`, () => {
      for (const { file, code } of FILES) {
        expectAbsent({
          pattern,
          from: code,
          provenBy,
          because:
            `${file} contains vocabulary from one client's industry. This screen ` +
            "is white-labelled and every client reads its copy as theirs, so a " +
            "word from somebody else's trade says we built it for someone else. " +
            "Say the shape instead of naming an example.",
        });
      }
    });
  }
});
