/**
 * Typed failures of the FFI SQLite binding (`platform/sqlite_ffi/`).
 *
 * Five tags, one per kind of cause, so a caller can decide what to do from the tag alone:
 *
 * | Tag                  | Cause                                                             | Typical response                 |
 * | -------------------- | ----------------------------------------------------------------- | -------------------------------- |
 * | `SqliteLibraryError` | `libsqlite3` could not be loaded or is unfit (old, single-thread) | startup failure                  |
 * | `SqliteError`        | SQLite itself returned an error code                              | map by `code` / `extendedCode`   |
 * | `SqliteCancelled`    | the binding interrupted a statement (deadline or abort signal)    | typed timeout / client cancel    |
 * | `SqliteUsageError`   | the caller broke the binding's contract (closed, busy, bind count)| programming error                |
 * | `SqliteValueError`   | a value cannot cross the boundary (bind type, unsafe integer)     | input or decode error            |
 *
 * Like `core/errors.ts`, every tag carries structured fields, never a pre-formatted message. These
 * tags are local to the binding on purpose: mapping them into `PlatformError` (and its HTTP status
 * table) belongs to the item that moves the storage path onto this binding.
 */
import { Data } from "effect";

/** The binding call that failed. */
export type SqliteOp =
  | "open"
  | "close"
  | "exec"
  | "prepare"
  | "bind"
  | "step"
  | "finalize";

/** Why `libsqlite3` was rejected at load time. */
export type LibraryFailure = "load-failed" | "too-old" | "not-threadsafe";

/** Why a statement was interrupted by the binding. */
export type CancelReason = "deadline" | "aborted";

/** Which contract rule the caller broke. */
export type UsageFailure =
  | "closed"
  | "finalized"
  | "busy"
  | "bind-count"
  | "bind-name"
  | "empty-statement"
  | "multiple-statements"
  | "nul-in-sql"
  | "invalid-option";

/** Which value could not cross the boundary. */
export type ValueFailure = "unsupported-bind-type" | "integer-out-of-range" | "unsafe-integer";

/** `libsqlite3` could not be loaded, or the loaded library cannot support this binding. */
export class SqliteLibraryError extends Data.TaggedError("SqliteLibraryError")<{
  readonly reason: LibraryFailure;
  /** Every path tried, in order. */
  readonly paths: readonly string[];
  /** The loader's own error text, or the offending version / threadsafe value. */
  readonly detail: string;
}> {}

/** SQLite returned a non-OK result code. */
export class SqliteError extends Data.TaggedError("SqliteError")<{
  readonly op: SqliteOp;
  /** Primary result code (`extendedCode & 0xff`), e.g. 19 for SQLITE_CONSTRAINT. */
  readonly code: number;
  /** Extended result code, e.g. 1555 for SQLITE_CONSTRAINT_PRIMARYKEY. */
  readonly extendedCode: number;
  /** Symbolic name of `extendedCode` when known, else of `code`. */
  readonly codeName: string;
  /** `sqlite3_errmsg` text at the time of failure. */
  readonly sqliteMessage: string;
  /** The statement text, when the failure belongs to one. */
  readonly sql?: string;
}> {}

/**
 * The binding interrupted a running statement because its deadline passed or its `AbortSignal`
 * fired. Any write the statement made inside an explicit transaction is rolled back by SQLite.
 */
export class SqliteCancelled extends Data.TaggedError("SqliteCancelled")<{
  readonly reason: CancelReason;
  readonly sql: string;
  /** Wall time from the start of the execution to the rejection, in ms. */
  readonly elapsedMs: number;
  /** Wall time from the cancel request to the statement returning, in ms. */
  readonly cancelLatencyMs: number;
  /** The `timeoutMs` the execution ran under, if any. */
  readonly timeoutMs?: number;
}> {}

/** The caller broke the binding's contract. */
export class SqliteUsageError extends Data.TaggedError("SqliteUsageError")<{
  readonly reason: UsageFailure;
  readonly detail: string;
  readonly sql?: string;
}> {}

/** A value could not be bound to, or read from, a statement. */
export class SqliteValueError extends Data.TaggedError("SqliteValueError")<{
  readonly reason: ValueFailure;
  /** Parameter (1-based index or name) or result column name. */
  readonly at: string | number;
  readonly detail: string;
  readonly sql: string;
}> {}

/** Every failure the binding raises. */
export type SqliteFfiError =
  | SqliteLibraryError
  | SqliteError
  | SqliteCancelled
  | SqliteUsageError
  | SqliteValueError;
