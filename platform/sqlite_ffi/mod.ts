/**
 * FFI SQLite binding: the system `libsqlite3` through Deno FFI, with a synchronous mode for bounded
 * statements and a nonblocking, deadline-bounded, interruptible mode for everything else.
 *
 * ```ts
 * using db = Database.open("tenant.db");
 * const byId = db.prepare("SELECT body FROM docs WHERE id = ?");
 * byId.get([42]);                                                      // main thread, ~node:sqlite cost
 * await db.prepare(listSql).allAsync(params, { timeoutMs: 250, signal }); // pool thread, cancellable
 * ```
 *
 * Needs `--allow-ffi`. See `database.ts` for the execution contract and `errors.ts` for the failure
 * taxonomy. Never open a file with this binding and `node:sqlite` in the same process at the same
 * time (`docs/knowledge/gotchas.md`).
 */
export {
  type BindParams,
  type BindValue,
  Database,
  type ExecOptions,
  type OpenOptions,
  type Row,
  type RunResult,
  type SqlValue,
  Statement,
} from "./database.ts";
export {
  type CancelReason,
  type LibraryFailure,
  SqliteCancelled,
  SqliteError,
  type SqliteFfiError,
  SqliteLibraryError,
  type SqliteOp,
  SqliteUsageError,
  SqliteValueError,
  type UsageFailure,
  type ValueFailure,
} from "./errors.ts";
export { DEFAULT_LIBRARY_PATHS, loadLibrary, MIN_VERSION_NUMBER, type SqliteLibrary } from "./library.ts";
