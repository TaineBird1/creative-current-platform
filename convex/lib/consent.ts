/**
 * WHICH CONSENT ROW WINS.
 *
 * Consents are append-only: a withdrawal is a new row, never an edit. So
 * "does this customer consent" is always a question about which row is
 * newest — and that turned out to be genuinely ambiguous.
 *
 * A grant and a withdrawal recorded in the SAME MILLISECOND sort equally.
 * `Array.prototype.sort` is stable in modern engines, but stability preserves
 * INPUT order, and the input is a database scan whose order is not
 * guaranteed. CI caught this as a test that passed locally and failed on the
 * runner: same code, different scan order, opposite answer.
 *
 * The resolution is two steps:
 *
 *   1. newest `at` wins
 *   2. tied `at` -> WITHDRAWN WINS
 *
 * There is deliberately NO `_creationTime` tie-break, and a first version of
 * this file had one. It made step 2 unreachable: `_creationTime` is unique
 * per insert, so it resolved every tie by WRITE ORDER — and write order is
 * not evidence of what the customer did. For a CSV import it is the order of
 * lines in a file. A test that reversed the insert order got the opposite
 * answer from the same data, which is what proved the rule was decorative.
 *
 * Step 2 is deliberately the opposite of this codebase's messaging default.
 * "Prefer sending twice over suppressing" is right when the cost is an
 * annoying duplicate. It is wrong here: the cost of guessing "granted" is a
 * message to somebody who asked us to stop, which is the one failure POPIA
 * actually cares about and a customer never forgives.
 *
 * The conservative error is recoverable — a customer who withdrew and
 * re-granted in the same millisecond stays suppressed until someone records a
 * grant with a later timestamp. The other error is not recoverable: the
 * message has already been sent.
 */

export type ConsentRow = {
  state: "granted" | "withdrawn";
  at: number;
};

export function resolveConsent<T extends ConsentRow>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;

  return rows.reduce((winner, row) => {
    if (row.at !== winner.at) return row.at > winner.at ? row : winner;
    // Same instant: we cannot know which the customer meant last.
    // Ambiguous consent is not consent.
    return row.state === "withdrawn" ? row : winner;
  });
}

/** True only when the newest resolvable row grants. Absent is NOT granted. */
export function hasConsent(rows: readonly ConsentRow[]): boolean {
  return resolveConsent(rows)?.state === "granted";
}
