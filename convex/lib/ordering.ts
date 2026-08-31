/**
 * DETERMINISTIC ORDERING.
 *
 * Two rows sharing a timestamp sort equally, and a database scan's order is
 * not guaranteed. That produces two different failures which must not be
 * confused, because the fix for one is forbidden for the other:
 *
 *   A TIE THAT DECIDES A FACT — "which consent is current", "which location
 *   is this job at". Breaking it by write order is WRONG: see the rule in
 *   CLAUDE.md. Resolve on meaning, or refuse to answer.
 *
 *   A TIE THAT ONLY ORDERS A LIST — a statement, an outbox, a calendar. Here
 *   the requirement is merely that the order does not change between two
 *   reads of the same data. `_id` is perfect for that BECAUSE it means
 *   nothing: it is a stable arbitrary, and using it makes no claim that one
 *   row happened before another.
 *
 * The comparators below are for the second case ONLY. Reach for one whenever a sort
 * key can repeat — which is most of them, and is systematic in a few places:
 * every message held over quiet hours shares one `scheduledFor`, and every
 * unscheduled job shares a null.
 *
 * A NOTE ON BALANCES. A derived balance is a SUM, and addition does not care
 * about order — tied ledger entries cannot change what an account totals.
 * What they change is the ORDER OF THE STATEMENT, which is why the ledger
 * readers here use this rather than something cleverer.
 */

type Rowish = { _id: string };

/**
 * Compare by `key` descending, then by `_id` for a stable arbitrary.
 * `_id` is presentation glue, never evidence — see the module note.
 */
export function byDesc<T extends Rowish>(key: (row: T) => number) {
  return (a: T, b: T): number => key(b) - key(a) || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
}

/** Compare by `key` ascending, then by `_id`. */
export function byAsc<T extends Rowish>(key: (row: T) => number) {
  return (a: T, b: T): number => key(a) - key(b) || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
}

/** Compare by a string field, then by `_id`. Two clients may share a name. */
export function byName<T extends Rowish>(key: (row: T) => string) {
  return (a: T, b: T): number =>
    key(a).localeCompare(key(b)) || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
}

/**
 * The catalogue order: an explicit `sortOrder` the owner sets, then the name.
 * Two rows can share BOTH — "sortOrder 0, no name yet" is what a freshly
 * created pair looks like — so `_id` closes it.
 */
export function byOrderThenName<T extends Rowish & { sortOrder: number; name: string }>(
  a: T,
  b: T,
): number {
  return (
    a.sortOrder - b.sortOrder ||
    a.name.localeCompare(b.name) ||
    (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)
  );
}
