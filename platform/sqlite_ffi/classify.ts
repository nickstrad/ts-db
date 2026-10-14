/**
 * The statement classifier (FFI plan, item FFI-05): which execution path a document operation takes.
 *
 * ```text
 *   bounded    insert, patch, delete; a select with an `_id` equality filter and no aggregate
 *              → the blocking path: sqlite3_step on the main thread (≈7 µs), never interrupted
 *   unbounded  every other select, count, countBy
 *              → the nonblocking path: sqlite3_step on Deno's blocking pool under
 *                `Config.sqlite.statementDeadlineMs`, stopped by sqlite3_interrupt (+35–60 µs)
 * ```
 *
 * The rule is a pure function of the IR (`sdk/db.ts`'s `Operation`), never of SQL text. `_id` is
 * every table's `PRIMARY KEY` (`core/compile/ddl.ts`), so `_id = ?` is SQLite's indexed single-row
 * lookup whatever else the plan filters, orders or limits by: it touches at most one row. An
 * aggregate (`count`, `countBy`) is unbounded even with an `_id` filter. That is deliberately
 * conservative: the nonblocking path costs tens of microseconds, so a misclassified short statement
 * only pays that, while a misclassified long one would block the event loop with no way to stop it.
 *
 * Writes are bounded by kind. Each runs one indexed single-row statement, and all of them stay on
 * the blocking path in any case: an interrupt that lands after an async write committed would leave
 * the commit standing while the caller reports a failure (FFI plan §4, FFI-05 step 3).
 */
import { Function as EffectFunction } from "effect";
import type { Operation, SelectPlan } from "../../sdk/db.ts";

/** Whether a statement's work is bounded by its plan (at most one row) or may run long. */
export type StatementClass = "bounded" | "unbounded";

/** The step path a class runs on; the `path` of a `sql` event (`core/events.ts`). */
export type ExecutionPath = "blocking" | "nonblocking";

/** True when `plan` filters `_id` by equality: the primary-key lookup. */
function selectsById(plan: SelectPlan): boolean {
  return plan.filters.some((filter) => filter.field === "_id" && filter.op === "eq");
}

/**
 * The class of one document operation. Bounded: `insert`, `patch`, `delete`, and a `select` whose
 * `filters` contain `{ field: "_id", op: "eq" }` and that has no `aggregate`. Unbounded: every other
 * `select`, including `count` and `countBy`.
 */
export function classify(operation: Operation): StatementClass {
  switch (operation.kind) {
    case "insert":
    case "patch":
    case "delete":
      return "bounded";
    case "select":
      return operation.aggregate === undefined && selectsById(operation) ? "bounded" : "unbounded";
    default:
      return EffectFunction.absurd<StatementClass>(operation);
  }
}

/** The path a class runs on: bounded → `"blocking"`, unbounded → `"nonblocking"`. */
export function pathOf(statementClass: StatementClass): ExecutionPath {
  return statementClass === "bounded" ? "blocking" : "nonblocking";
}
