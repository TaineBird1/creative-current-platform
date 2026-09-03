import type { MutationCtx } from "../_generated/server";
import type { DataModel, Doc, Id, TableNames } from "../_generated/dataModel";
import { IMMUTABLE_TABLES } from "../schema";

/**
 * THE ONLY MODULE PERMITTED TO MUTATE A DOCUMENT IN PLACE.
 *
 * Same shape as `lib/leadAccess.ts`, and for the same reason: one module owns
 * a capability, everything else is banned from the raw form, and the ban is a
 * scan for a literal token rather than an inference about meaning.
 *
 * WHY THIS EXISTS AT ALL — the guard it replaces could never have worked.
 *
 * `guards.test.ts` used to assert immutability by matching
 * `db\\.(patch|delete|replace)\\([^)]*<table>` against the source. Convex's
 * `db.patch(id, partial)` NEVER contains a table name: a real violation reads
 * `ctx.db.patch(entry._id, { amountCents: 0 })`. So for every listed table the
 * protection was ZERO — not dormant, incapable — and a control proved it by
 * planting a function that both patched and deleted a ledger entry and
 * watching the whole suite pass green.
 *
 * THE LADDER, which is the general lesson rather than a note about this bug:
 *
 *   WEAKEST   a guard that infers a fact from source. It can be satisfied by
 *             text that means something else, or — as here — assert a thing
 *             the text can never contain.
 *   STRONGER  a guard that matches a literal token which is genuinely present.
 *             It can fire, because it is looking for something that is there.
 *   STRONGEST the type system. Nothing has to run, nothing has to be scanned,
 *             and it cannot be satisfied by accident.
 *
 * Both upper rungs are used here. `patchDoc` and friends are generic over
 * MUTABLE tables only, so passing an `Id<"ledgerEntries">` is a COMPILE error
 * — `Id` is branded with its table name, so the constraint has something real
 * to reject. And `guards.test.ts` bans the literal strings `ctx.db.patch`,
 * `ctx.db.delete` and `ctx.db.replace` everywhere but this file, so the typed
 * helpers cannot simply be bypassed.
 *
 * Deleting a row of an append-only table is not a thing to do carefully. It is
 * a thing that should not compile.
 */

type ImmutableTable = (typeof IMMUTABLE_TABLES)[number];

/**
 * Every table except the append-only ones.
 *
 * Derived from `IMMUTABLE_TABLES` rather than listed again, so adding a table
 * to that array is the single edit that makes it uneditable — and forgetting
 * to update a second list is not a mistake available to make.
 */
export type MutableTable = Exclude<TableNames, ImmutableTable>;

/**
 * Edit some fields of a document.
 *
 * `T` is inferred from the id's brand, so this refuses an immutable table at
 * compile time with no annotation at the call site:
 *
 *   patchDoc(ctx, invoiceId, { status: "void" })       // fine
 *   patchDoc(ctx, ledgerEntryId, { amountCents: 0 })   // does not compile
 *
 * Correct an append-only row by inserting a new one that reverses it — see
 * `reverseEntry` in lib/ledger.ts, which is what that looks like.
 */
export function patchDoc<T extends MutableTable>(
  ctx: MutationCtx,
  id: Id<T>,
  fields: Partial<DataModel[T]["document"]>,
): Promise<void> {
  return ctx.db.patch(id, fields);
}

/**
 * Replace a document wholesale.
 *
 * Rarer than `patchDoc` and worth the extra thought when you reach for it: a
 * replace drops every field you did not mention, so a column added later is
 * silently cleared by a call written before it existed.
 */
export function replaceDoc<T extends MutableTable>(
  ctx: MutationCtx,
  id: Id<T>,
  document: Omit<Doc<T>, "_id" | "_creationTime">,
): Promise<void> {
  return ctx.db.replace(id, document as never);
}

/**
 * Delete a document.
 *
 * Named `deleteDoc` because `delete` is a reserved word, and the suffix is
 * worth it: `deleteDoc(ctx, id)` reads as deliberately as the thing deserves.
 *
 * Most of this codebase does not delete. An invoice is voided, a demo expires,
 * a lead is suppressed, a consent is superseded — because the row is the
 * record of something that happened, and the question later is always "what
 * happened", never "what is left". The legitimate uses are seed teardown and
 * genuinely transient rows.
 */
export function deleteDoc<T extends MutableTable>(
  ctx: MutationCtx,
  id: Id<T>,
): Promise<void> {
  return ctx.db.delete(id);
}
