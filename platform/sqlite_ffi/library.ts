/**
 * Loading the system `libsqlite3` through Deno FFI.
 *
 * The symbol table below is the binding's entire native surface. Two entries name the same C
 * function: `sqlite3_step` runs on the calling (main) thread and `sqlite3_step_nb` is the same
 * function marked `nonblocking`, which Deno runs on its blocking thread pool and resolves as a
 * Promise, leaving the event loop free. `sqlite3_interrupt` is the one call SQLite documents as safe
 * from another thread while a statement runs; the binding makes it from the main thread while a
 * pool thread is inside `sqlite3_step_nb`.
 *
 * A loaded library is cached per path and never closed: `dlclose` while a pool thread may still be
 * inside SQLite would unmap running code.
 *
 * Two copies of SQLite in one process (this library plus the one bundled inside `node:sqlite`)
 * must never open the same database file at the same time: POSIX advisory locks are per process,
 * so closing a file descriptor in one copy silently drops the other copy's locks. See
 * `docs/knowledge/gotchas.md`.
 */
import { SqliteLibraryError } from "./errors.ts";

/** Paths tried, in order, when the caller does not name one. Bare names use the dlopen search path. */
export const DEFAULT_LIBRARY_PATHS: readonly string[] = [
  "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
  "libsqlite3.so.0",
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "libsqlite3.dylib",
];

/** Oldest supported library: 3.37.0 added `sqlite3_changes64`. */
export const MIN_VERSION_NUMBER = 3_037_000;

const SYMBOLS = {
  sqlite3_libversion: { parameters: [], result: "pointer" },
  sqlite3_libversion_number: { parameters: [], result: "i32" },
  sqlite3_threadsafe: { parameters: [], result: "i32" },
  sqlite3_errstr: { parameters: ["i32"], result: "pointer" },

  sqlite3_open_v2: { parameters: ["buffer", "buffer", "i32", "pointer"], result: "i32" },
  sqlite3_close_v2: { parameters: ["pointer"], result: "i32" },
  // Variadic in C: this fixed signature is for the DQS verbs (int on/off, int* out or NULL).
  sqlite3_db_config: { parameters: ["pointer", "i32", "i32", "pointer"], result: "i32" },
  sqlite3_extended_result_codes: { parameters: ["pointer", "i32"], result: "i32" },
  sqlite3_busy_timeout: { parameters: ["pointer", "i32"], result: "i32" },
  sqlite3_errmsg: { parameters: ["pointer"], result: "pointer" },
  sqlite3_extended_errcode: { parameters: ["pointer"], result: "i32" },
  sqlite3_exec: { parameters: ["pointer", "buffer", "pointer", "pointer", "pointer"], result: "i32" },
  sqlite3_changes64: { parameters: ["pointer"], result: "i64" },
  sqlite3_last_insert_rowid: { parameters: ["pointer"], result: "i64" },
  sqlite3_interrupt: { parameters: ["pointer"], result: "void" },
  sqlite3_get_autocommit: { parameters: ["pointer"], result: "i32" },

  sqlite3_prepare_v2: { parameters: ["pointer", "buffer", "i32", "buffer", "buffer"], result: "i32" },
  sqlite3_finalize: { parameters: ["pointer"], result: "i32" },
  sqlite3_reset: { parameters: ["pointer"], result: "i32" },
  sqlite3_clear_bindings: { parameters: ["pointer"], result: "i32" },
  sqlite3_step: { parameters: ["pointer"], result: "i32" },
  sqlite3_step_nb: { name: "sqlite3_step", parameters: ["pointer"], result: "i32", nonblocking: true },

  sqlite3_bind_parameter_count: { parameters: ["pointer"], result: "i32" },
  sqlite3_bind_parameter_index: { parameters: ["pointer", "buffer"], result: "i32" },
  sqlite3_bind_null: { parameters: ["pointer", "i32"], result: "i32" },
  sqlite3_bind_int: { parameters: ["pointer", "i32", "i32"], result: "i32" },
  sqlite3_bind_int64: { parameters: ["pointer", "i32", "i64"], result: "i32" },
  sqlite3_bind_double: { parameters: ["pointer", "i32", "f64"], result: "i32" },
  sqlite3_bind_text: { parameters: ["pointer", "i32", "buffer", "i32", "pointer"], result: "i32" },
  sqlite3_bind_blob: { parameters: ["pointer", "i32", "buffer", "i32", "pointer"], result: "i32" },
  sqlite3_bind_zeroblob: { parameters: ["pointer", "i32", "i32"], result: "i32" },

  sqlite3_stmt_status: { parameters: ["pointer", "i32", "i32"], result: "i32" },
  sqlite3_column_count: { parameters: ["pointer"], result: "i32" },
  sqlite3_column_name: { parameters: ["pointer", "i32"], result: "pointer" },
  sqlite3_column_type: { parameters: ["pointer", "i32"], result: "i32" },
  sqlite3_column_int64: { parameters: ["pointer", "i32"], result: "i64" },
  sqlite3_column_double: { parameters: ["pointer", "i32"], result: "f64" },
  sqlite3_column_text: { parameters: ["pointer", "i32"], result: "pointer" },
  sqlite3_column_blob: { parameters: ["pointer", "i32"], result: "pointer" },
  sqlite3_column_bytes: { parameters: ["pointer", "i32"], result: "i32" },
} as const satisfies Deno.ForeignLibraryInterface;

/** The loaded native surface. */
export type SqliteSymbols = Deno.DynamicLibrary<typeof SYMBOLS>["symbols"];

/** A loaded, validated `libsqlite3`. */
export interface SqliteLibrary {
  readonly path: string;
  /** e.g. `"3.45.1"`. */
  readonly version: string;
  /** e.g. `3045001`. */
  readonly versionNumber: number;
  readonly symbols: SqliteSymbols;
}

const loaded = new Map<string, SqliteLibrary>();

/**
 * Load and validate `libsqlite3`. With no `path`, tries `DEFAULT_LIBRARY_PATHS` in order and keeps
 * the first that opens. Fails `SqliteLibraryError` if none opens (including a missing `--allow-ffi`),
 * if the library is older than `MIN_VERSION_NUMBER`, or if it was built single-threaded
 * (`SQLITE_THREADSAFE=0`), which would make the off-thread step and `sqlite3_interrupt` unsafe.
 */
export function loadLibrary(path?: string): SqliteLibrary {
  const candidates = path === undefined ? DEFAULT_LIBRARY_PATHS : [path];
  for (const candidate of candidates) {
    const hit = loaded.get(candidate);
    if (hit !== undefined) return hit;
  }
  const failures: string[] = [];
  for (const candidate of candidates) {
    let lib: Deno.DynamicLibrary<typeof SYMBOLS>;
    try {
      lib = Deno.dlopen(candidate, SYMBOLS);
    } catch (cause) {
      failures.push(`${candidate}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    const s = lib.symbols;
    const versionNumber = s.sqlite3_libversion_number();
    const threadsafe = s.sqlite3_threadsafe();
    if (versionNumber < MIN_VERSION_NUMBER) {
      lib.close();
      throw new SqliteLibraryError({
        reason: "too-old",
        paths: [candidate],
        detail: `version ${versionNumber} < ${MIN_VERSION_NUMBER}`,
      });
    }
    if (threadsafe === 0) {
      lib.close();
      throw new SqliteLibraryError({
        reason: "not-threadsafe",
        paths: [candidate],
        detail: "sqlite3_threadsafe() = 0",
      });
    }
    const versionPtr = s.sqlite3_libversion();
    const library: SqliteLibrary = {
      path: candidate,
      version: versionPtr === null ? String(versionNumber) : Deno.UnsafePointerView.getCString(versionPtr),
      versionNumber,
      symbols: s,
    };
    loaded.set(candidate, library);
    return library;
  }
  throw new SqliteLibraryError({ reason: "load-failed", paths: candidates, detail: failures.join("; ") });
}
