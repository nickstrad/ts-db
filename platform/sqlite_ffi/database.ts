/**
 * `Database` and `Statement`: a small, typed binding over the system `libsqlite3` (via
 * `./library.ts`) with two execution modes per statement.
 *
 * ```text
 *   sync   run / get / all             sqlite3_step on the main thread    ~node:sqlite cost, unbounded
 *   async  runAsync / getAsync / ...   sqlite3_step on a pool thread      +35-60 µs per step, cancellable
 *                                      timeoutMs / AbortSignal ─> sqlite3_interrupt from the main thread
 * ```
 *
 * The sync mode is for statements with a bounded plan (point reads, single-row writes): it has no
 * thread hop, and it cannot be interrupted, because the thread that would call `sqlite3_interrupt`
 * is the one running the statement. The async mode is for everything else: each `sqlite3_step`
 * runs off the event loop, and a deadline or abort calls `sqlite3_interrupt`, which makes the step
 * return `SQLITE_INTERRUPT` within about a millisecond; the execution rejects `SqliteCancelled`.
 *
 * Rules the binding enforces, all as `SqliteUsageError`:
 *
 * 1. **One execution per connection at a time.** While an async execution is in flight, every other
 *    call on that connection (sync or async, including `close`) fails `"busy"` instead of blocking
 *    the main thread on SQLite's connection mutex or racing the pool thread. `closeAsync` cancels
 *    the in-flight execution and waits for it. Concurrency comes from more connections.
 * 2. **Executions run to completion.** Every method steps its statement to the end (or to the first
 *    row for `get`) and resets it before returning, so no statement is left active between calls.
 *    That keeps `sqlite3_interrupt` scoped to the one execution that asked for it: SQLite clears the
 *    interrupt flag when the next statement starts on an otherwise idle connection.
 * 3. **Lifetimes are explicit.** `close` finalizes the connection's statements; a statement or
 *    connection used after that fails `"finalized"` / `"closed"` rather than touching freed memory.
 *    No `FinalizationRegistry`: a dropped connection leaks its handle, it does not crash.
 *
 * Values: `null`, `number` (integral and safe → INTEGER, else REAL), `bigint` (INTEGER, 64-bit
 * range), `boolean` (0/1), `string` (TEXT, embedded U+0000 preserved), `Uint8Array` / any
 * `ArrayBufferView` (BLOB). `undefined` is rejected so a missing field never binds NULL silently.
 * INTEGER columns read back as `number`; outside ±(2^53−1) they fail `SqliteValueError` unless the
 * connection was opened with `readBigInts`, in which case every INTEGER reads as `bigint` (the same
 * contract as `node:sqlite`). Rows are null-prototype objects keyed by column name.
 */
import {
  type CancelReason,
  SqliteCancelled,
  SqliteError,
  type SqliteOp,
  SqliteUsageError,
  SqliteValueError,
  type UsageFailure,
} from "./errors.ts";
import { loadLibrary, type SqliteLibrary, type SqliteSymbols } from "./library.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SQLITE_OK = 0;
const SQLITE_INTERRUPT = 9;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;

const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;

const SQLITE_STMTSTATUS_REPREPARE = 5;

const SQLITE_OPEN_READONLY = 0x1;
const SQLITE_OPEN_READWRITE = 0x2;
const SQLITE_OPEN_CREATE = 0x4;
const SQLITE_OPEN_URI = 0x40;
const SQLITE_OPEN_FULLMUTEX = 0x10000;
const SQLITE_OPEN_EXRESCODE = 0x2000000;

/** `SQLITE_TRANSIENT`: SQLite copies bound text/blob before the bind call returns. */
const SQLITE_TRANSIENT = Deno.UnsafePointer.create(0xffff_ffff_ffff_ffffn);

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const PRIMARY_CODE_NAMES: Readonly<Record<number, string>> = {
  1: "SQLITE_ERROR",
  2: "SQLITE_INTERNAL",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM",
  8: "SQLITE_READONLY",
  9: "SQLITE_INTERRUPT",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  12: "SQLITE_NOTFOUND",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  15: "SQLITE_PROTOCOL",
  16: "SQLITE_EMPTY",
  17: "SQLITE_SCHEMA",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  22: "SQLITE_NOLFS",
  23: "SQLITE_AUTH",
  24: "SQLITE_FORMAT",
  25: "SQLITE_RANGE",
  26: "SQLITE_NOTADB",
  27: "SQLITE_NOTICE",
  28: "SQLITE_WARNING",
};

const EXTENDED_CODE_NAMES: Readonly<Record<number, string>> = {
  261: "SQLITE_BUSY_RECOVERY",
  517: "SQLITE_BUSY_SNAPSHOT",
  773: "SQLITE_BUSY_TIMEOUT",
  262: "SQLITE_LOCKED_SHAREDCACHE",
  264: "SQLITE_READONLY_RECOVERY",
  520: "SQLITE_READONLY_CANTLOCK",
  776: "SQLITE_READONLY_ROLLBACK",
  1032: "SQLITE_READONLY_DBMOVED",
  275: "SQLITE_CONSTRAINT_CHECK",
  531: "SQLITE_CONSTRAINT_COMMITHOOK",
  787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1043: "SQLITE_CONSTRAINT_FUNCTION",
  1299: "SQLITE_CONSTRAINT_NOTNULL",
  1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  1811: "SQLITE_CONSTRAINT_TRIGGER",
  2067: "SQLITE_CONSTRAINT_UNIQUE",
  2323: "SQLITE_CONSTRAINT_VTAB",
  2579: "SQLITE_CONSTRAINT_ROWID",
  2835: "SQLITE_CONSTRAINT_PINNED",
  3091: "SQLITE_CONSTRAINT_DATATYPE",
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A value that can be bound to a statement parameter. */
export type BindValue = null | number | bigint | boolean | string | ArrayBufferView;

/** Positional (`?`, `?NNN`) or named (`:name`, `@name`, `$name`) parameters. */
export type BindParams = readonly BindValue[] | Readonly<Record<string, BindValue>>;

/** A value read from a result column. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** One result row: column name → value, on a null prototype. */
export type Row = Record<string, SqlValue>;

/** What a `run` reports. */
export interface RunResult {
  /** Rows changed by the statement (`sqlite3_changes64`). */
  readonly changes: number;
  /** `sqlite3_last_insert_rowid` after the statement. */
  readonly lastInsertRowid: number | bigint;
}

export interface OpenOptions {
  /** Open read-only (`SQLITE_OPEN_READONLY`). Default false. */
  readonly readOnly?: boolean;
  /** Create the file if missing. Default true; ignored when `readOnly`. */
  readonly create?: boolean;
  /** Interpret `path` as a `file:` URI. Default false. */
  readonly uri?: boolean;
  /**
   * `sqlite3_busy_timeout` in ms. Default 0 (fail `SQLITE_BUSY` at once). A sync call that waits on
   * a lock waits on the main thread, so keep this small unless the connection only runs async work.
   */
  readonly busyTimeoutMs?: number;
  /** Read every INTEGER column as `bigint`. Default false. */
  readonly readBigInts?: boolean;
  /** `libsqlite3` to load; default `DEFAULT_LIBRARY_PATHS` in `./library.ts`. */
  readonly libraryPath?: string;
}

/** Bounds on an async execution. */
export interface ExecOptions {
  /**
   * Deadline, in ms from the call. When it passes the binding calls `sqlite3_interrupt` and the
   * execution rejects `SqliteCancelled({ reason: "deadline" })`.
   */
  readonly timeoutMs?: number;
  /** Abort the execution early: rejects `SqliteCancelled({ reason: "aborted" })`. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Connection state shared by a Database and its Statements
// ---------------------------------------------------------------------------

/** The bookkeeping for one in-flight async execution. */
interface Execution {
  /** True while a pool thread is inside `sqlite3_step_nb` for this execution. */
  inStep: boolean;
  cancelled: CancelReason | null;
  cancelledAt: number;
  /** Cancel the execution: interrupt it if it is inside a step, else stop it before the next one. */
  cancel(reason: CancelReason): void;
  /** Resolves once the execution has reset its statement and released the connection. */
  readonly settled: Promise<void>;
}

interface Connection {
  readonly s: SqliteSymbols;
  readonly db: Deno.PointerObject;
  readonly path: string;
  readonly readBigInts: boolean;
  open: boolean;
  active: Execution | null;
  readonly statements: Set<Statement>;
}

// Out-parameter scratch for synchronous calls only (never shared with a nonblocking call).
const ptrOut = new BigUint64Array(1);
const ptrOutBytes = new Uint8Array(ptrOut.buffer);
const tailOut = new BigUint64Array(1);
const tailOutBytes = new Uint8Array(tailOut.buffer);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** A non-empty buffer for binding "" (an empty buffer would pass NULL and bind SQL NULL). */
const EMPTY_TEXT = new Uint8Array(1);

function cString(s: string): Uint8Array {
  return encoder.encode(s + "\0");
}

function readCString(p: Deno.PointerValue): string {
  return p === null ? "" : Deno.UnsafePointerView.getCString(p);
}

/**
 * Decode `len` bytes of UTF-8 at `p`. `getCString` is the fast path; it stops at the first NUL,
 * so its result is kept only when its UTF-16 length equals `len`, which holds exactly when the text
 * is all ASCII without NUL (every other code point takes more UTF-8 bytes than UTF-16 units, and a
 * NUL would cut the string short). Anything else is decoded from the full byte range.
 */
function readText(p: Deno.PointerObject, len: number): string {
  const fast = Deno.UnsafePointerView.getCString(p);
  if (fast.length === len) return fast;
  return decoder.decode(new Uint8Array(Deno.UnsafePointerView.getArrayBuffer(p, len)));
}

function codeName(extendedCode: number): string {
  return EXTENDED_CODE_NAMES[extendedCode] ?? PRIMARY_CODE_NAMES[extendedCode & 0xff] ??
    `SQLITE_UNKNOWN_${extendedCode}`;
}

function sqliteError(c: Connection, op: SqliteOp, rc: number, sql?: string): SqliteError {
  // Only the primary code is guaranteed when `rc` came from a call that does not set the
  // connection's error state; prefer the connection's extended code when it agrees.
  const ext = c.s.sqlite3_extended_errcode(c.db);
  const extendedCode = (ext & 0xff) === (rc & 0xff) ? ext : rc;
  const message = readCString(c.s.sqlite3_errmsg(c.db));
  return new SqliteError({
    op,
    code: extendedCode & 0xff,
    extendedCode,
    codeName: codeName(extendedCode),
    sqliteMessage: message !== "" ? message : readCString(c.s.sqlite3_errstr(rc)),
    ...(sql === undefined ? {} : { sql }),
  });
}

function usage(reason: UsageFailure, detail: string, sql?: string): SqliteUsageError {
  return new SqliteUsageError({ reason, detail, ...(sql === undefined ? {} : { sql }) });
}

function assertIdle(c: Connection, what: string, sql?: string): void {
  if (!c.open) throw usage("closed", `${what} on a closed connection`, sql);
  if (c.active !== null) {
    throw usage("busy", `${what} while an async execution is in flight on this connection`, sql);
  }
}

/** SQLite stops reading SQL text at U+0000, so a script containing one would run only in part. */
function assertNoNul(sql: string): void {
  if (sql.includes("\0")) throw usage("nul-in-sql", "SQL text contains U+0000", sql);
}

function toNumber(v: number | bigint): number | bigint {
  return typeof v === "bigint" && v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** One SQLite connection. */
export class Database {
  readonly #c: Connection;
  /** The library this connection was opened with. */
  readonly library: SqliteLibrary;

  private constructor(c: Connection, library: SqliteLibrary) {
    this.#c = c;
    this.library = library;
  }

  /**
   * Open a connection (`sqlite3_open_v2` with `SQLITE_OPEN_FULLMUTEX` and extended result codes).
   * Fails `SqliteLibraryError` if the library cannot be loaded, `SqliteUsageError` on a bad
   * option, `SqliteError({ op: "open" })` if SQLite refuses.
   */
  static open(path: string, options: OpenOptions = {}): Database {
    const busyTimeoutMs = options.busyTimeoutMs ?? 0;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 0x7fff_ffff) {
      throw usage("invalid-option", `busyTimeoutMs must be a non-negative int32, got ${busyTimeoutMs}`);
    }
    const library = loadLibrary(options.libraryPath);
    const s = library.symbols;
    const flags =
      (options.readOnly
        ? SQLITE_OPEN_READONLY
        : SQLITE_OPEN_READWRITE | (options.create === false ? 0 : SQLITE_OPEN_CREATE)) |
      (options.uri ? SQLITE_OPEN_URI : 0) | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_EXRESCODE;
    ptrOut[0] = 0n;
    const rc = s.sqlite3_open_v2(cString(path), ptrOutBytes, flags, null);
    const db = Deno.UnsafePointer.create(ptrOut[0]);
    if (rc !== SQLITE_OK || db === null) {
      // sqlite3_open_v2 allocates a handle even on most failures; read its message, then free it.
      const message = db === null ? "" : readCString(s.sqlite3_errmsg(db));
      if (db !== null) s.sqlite3_close_v2(db);
      const code = rc === SQLITE_OK ? 7 : rc;
      throw new SqliteError({
        op: "open",
        code: code & 0xff,
        extendedCode: code,
        codeName: codeName(code),
        sqliteMessage: message !== "" ? message : readCString(s.sqlite3_errstr(code)),
      });
    }
    const c: Connection = {
      s,
      db,
      path,
      readBigInts: options.readBigInts ?? false,
      open: true,
      active: null,
      statements: new Set(),
    };
    s.sqlite3_extended_result_codes(db, 1);
    if (busyTimeoutMs > 0) s.sqlite3_busy_timeout(db, busyTimeoutMs);
    return new Database(c, library);
  }

  /** The path the connection was opened with. */
  get path(): string {
    return this.#c.path;
  }

  get isOpen(): boolean {
    return this.#c.open;
  }

  /** True while an async execution holds this connection. */
  get inFlight(): boolean {
    return this.#c.active !== null;
  }

  /** Run zero or more `;`-separated statements without parameters or results (`sqlite3_exec`). */
  exec(sql: string): void {
    const c = this.#c;
    assertIdle(c, "exec", sql);
    assertNoNul(sql);
    const rc = c.s.sqlite3_exec(c.db, cString(sql), null, null, null);
    if (rc !== SQLITE_OK) throw sqliteError(c, "exec", rc, sql);
  }

  /**
   * Compile exactly one statement. Trailing whitespace and comments are allowed; a second
   * statement fails `"multiple-statements"` (use `exec` for scripts), none fails `"empty-statement"`.
   */
  prepare(sql: string): Statement {
    const c = this.#c;
    assertIdle(c, "prepare", sql);
    assertNoNul(sql);
    const bytes = encoder.encode(sql);
    // Copy into a fresh ArrayBuffer so the bytes live in a stable off-heap backing store: the tail
    // pointer SQLite returns is an address inside this buffer.
    const buf = new Uint8Array(new ArrayBuffer(bytes.length + 1));
    buf.set(bytes);
    const stmt = prepareOne(c, buf, bytes.length, sql);
    if (stmt === null) throw usage("empty-statement", "the SQL contains no statement", sql);
    const base = Deno.UnsafePointer.value(Deno.UnsafePointer.of(buf));
    const offset = Number(tailOut[0] - BigInt(base));
    if (offset < 0 || offset > bytes.length) {
      c.s.sqlite3_finalize(stmt);
      throw usage("multiple-statements", "could not locate the end of the first statement", sql);
    }
    if (offset < bytes.length) {
      let next: Deno.PointerObject | null;
      try {
        next = prepareOne(c, buf.slice(offset, bytes.length + 1), bytes.length - offset, sql);
      } catch (e) {
        c.s.sqlite3_finalize(stmt);
        throw e;
      }
      if (next !== null) {
        c.s.sqlite3_finalize(next);
        c.s.sqlite3_finalize(stmt);
        throw usage("multiple-statements", "prepare accepts one statement; use exec for scripts", sql);
      }
    }
    const statement = new Statement(c, stmt, sql);
    c.statements.add(statement);
    return statement;
  }

  /**
   * `sqlite3_interrupt` on this connection, unconditionally. Prefer `timeoutMs` / `signal` on the
   * async methods, which scope the interrupt to one execution and report `SqliteCancelled`.
   */
  interrupt(): void {
    if (this.#c.open) this.#c.s.sqlite3_interrupt(this.#c.db);
  }

  /**
   * Finalize every statement and close the connection. Idempotent. Fails `"busy"` while an async
   * execution is in flight (closing under a running pool thread would free memory it is using);
   * use `closeAsync` to cancel and wait instead.
   */
  close(): void {
    const c = this.#c;
    if (!c.open) return;
    if (c.active !== null) throw usage("busy", "close while an async execution is in flight");
    for (const st of c.statements) st[finalizeInternal]();
    c.statements.clear();
    c.open = false;
    const rc = c.s.sqlite3_close_v2(c.db);
    if (rc !== SQLITE_OK) throw sqliteError(c, "close", rc);
  }

  /** Cancel the in-flight async execution (if any), wait for it to release the connection, close. */
  async closeAsync(): Promise<void> {
    // Loop: another caller may start an execution between one settling and this continuation.
    for (let active = this.#c.active; active !== null; active = this.#c.active) {
      active.cancel("aborted");
      await active.settled;
    }
    this.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.closeAsync();
  }
}

function prepareOne(c: Connection, buf: Uint8Array, nBytes: number, sql: string): Deno.PointerObject | null {
  ptrOut[0] = 0n;
  tailOut[0] = 0n;
  const rc = c.s.sqlite3_prepare_v2(c.db, buf, nBytes, ptrOutBytes, tailOutBytes);
  const stmt = Deno.UnsafePointer.create(ptrOut[0]);
  if (rc !== SQLITE_OK) {
    if (stmt !== null) c.s.sqlite3_finalize(stmt);
    throw sqliteError(c, "prepare", rc, sql);
  }
  return stmt;
}

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------

const finalizeInternal = Symbol("finalizeInternal");

type Mode = "run" | "get" | "all";

/** A prepared statement. Created by `Database.prepare`; finalized by `finalize` or `Database.close`. */
export class Statement {
  readonly #c: Connection;
  readonly #stmt: Deno.PointerObject;
  readonly #paramCount: number;
  #names: Map<string, number> | null = null;
  #columns: string[] | null = null;
  #columnsEpoch = -1;
  /** True when SQLite holds a copy of a bound text or blob that `clear_bindings` would free. */
  #holdsCopies = false;
  #finalized = false;
  /** The SQL text this statement was prepared from. */
  readonly sql: string;

  /** @internal Use `Database.prepare`. */
  constructor(c: Connection, stmt: Deno.PointerObject, sql: string) {
    this.#c = c;
    this.#stmt = stmt;
    this.sql = sql;
    this.#paramCount = c.s.sqlite3_bind_parameter_count(stmt);
  }

  /** Number of parameters (the largest parameter index). */
  get parameterCount(): number {
    return this.#paramCount;
  }

  get isFinalized(): boolean {
    return this.#finalized;
  }

  /** Run to completion on the main thread; report changes and the last rowid. */
  run(params?: BindParams): RunResult {
    return this.#sync("run", params) as RunResult;
  }

  /** First row on the main thread, or `undefined`. */
  get(params?: BindParams): Row | undefined {
    return this.#sync("get", params) as Row | undefined;
  }

  /** All rows on the main thread. */
  all(params?: BindParams): Row[] {
    return this.#sync("all", params) as Row[];
  }

  /** `run`, each step off the event loop, bounded by `options`. */
  runAsync(params?: BindParams, options?: ExecOptions): Promise<RunResult> {
    return this.#async("run", params, options) as Promise<RunResult>;
  }

  /** `get`, each step off the event loop, bounded by `options`. */
  getAsync(params?: BindParams, options?: ExecOptions): Promise<Row | undefined> {
    return this.#async("get", params, options) as Promise<Row | undefined>;
  }

  /** `all`, each step off the event loop, bounded by `options`. */
  allAsync(params?: BindParams, options?: ExecOptions): Promise<Row[]> {
    return this.#async("all", params, options) as Promise<Row[]>;
  }

  /** Release the statement. Idempotent. Fails `"busy"` while an async execution is in flight. */
  finalize(): void {
    if (this.#finalized) return;
    if (this.#c.active !== null) {
      throw usage("busy", "finalize while an async execution is in flight", this.sql);
    }
    this[finalizeInternal]();
    this.#c.statements.delete(this);
  }

  /** @internal */
  [finalizeInternal](): void {
    if (this.#finalized) return;
    this.#finalized = true;
    this.#c.s.sqlite3_finalize(this.#stmt);
  }

  #assertUsable(what: string): void {
    if (this.#finalized) {
      throw usage(this.#c.open ? "finalized" : "closed", `${what} on a finalized statement`, this.sql);
    }
    assertIdle(this.#c, what, this.sql);
  }

  #sync(mode: Mode, params: BindParams | undefined): RunResult | Row | Row[] | undefined {
    this.#assertUsable(mode);
    const { s } = this.#c;
    const stmt = this.#stmt;
    try {
      this.#bind(params);
      const rows: Row[] = [];
      let names: string[] | null = null;
      for (;;) {
        const rc = s.sqlite3_step(stmt);
        if (rc === SQLITE_ROW) {
          if (mode === "run") continue;
          names ??= this.#columnNames();
          rows.push(this.#readRow(names));
          if (mode === "get") break;
          continue;
        }
        if (rc === SQLITE_DONE) break;
        throw sqliteError(this.#c, "step", rc, this.sql);
      }
      return this.#result(mode, rows);
    } finally {
      s.sqlite3_reset(stmt);
      if (this.#holdsCopies) {
        s.sqlite3_clear_bindings(stmt);
        this.#holdsCopies = false;
      }
    }
  }

  async #async(
    mode: Mode,
    params: BindParams | undefined,
    options: ExecOptions = {},
  ): Promise<RunResult | Row | Row[] | undefined> {
    this.#assertUsable(`${mode}Async`);
    const { timeoutMs, signal } = options;
    if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs >= 0)) {
      throw usage("invalid-option", `timeoutMs must be a finite number >= 0, got ${timeoutMs}`, this.sql);
    }
    const c = this.#c;
    const { s, db } = c;
    const stmt = this.#stmt;
    const started = performance.now();
    if (signal?.aborted) {
      throw new SqliteCancelled({
        reason: "aborted",
        sql: this.sql,
        elapsedMs: 0,
        cancelLatencyMs: 0,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    }

    let release!: () => void;
    const exec: Execution = {
      inStep: false,
      cancelled: null,
      cancelledAt: 0,
      cancel(reason) {
        if (exec.cancelled !== null) return;
        exec.cancelled = reason;
        exec.cancelledAt = performance.now();
        // Only interrupt while our step is on a pool thread: an interrupt with no statement running
        // would linger and hit the connection's next statement.
        if (exec.inStep && c.open) s.sqlite3_interrupt(db);
      },
      settled: new Promise<void>((resolve) => (release = resolve)),
    };
    c.active = exec;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => exec.cancel("deadline"), timeoutMs);
    const onAbort = () => exec.cancel("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const cancelledError = () => {
      const now = performance.now();
      return new SqliteCancelled({
        reason: exec.cancelled ?? "aborted",
        sql: this.sql,
        elapsedMs: now - started,
        cancelLatencyMs: now - exec.cancelledAt,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    };

    try {
      this.#bind(params);
      const rows: Row[] = [];
      let names: string[] | null = null;
      for (;;) {
        if (exec.cancelled !== null) throw cancelledError();
        exec.inStep = true;
        let rc: number;
        try {
          rc = await s.sqlite3_step_nb(stmt);
        } finally {
          exec.inStep = false;
        }
        if (rc === SQLITE_ROW) {
          if (mode === "run") continue;
          names ??= this.#columnNames();
          rows.push(this.#readRow(names));
          if (mode === "get") break;
          continue;
        }
        if (rc === SQLITE_DONE) break;
        if (exec.cancelled !== null && (rc & 0xff) === SQLITE_INTERRUPT) throw cancelledError();
        throw sqliteError(c, "step", rc, this.sql);
      }
      return this.#result(mode, rows);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      s.sqlite3_reset(stmt);
      if (this.#holdsCopies) {
        s.sqlite3_clear_bindings(stmt);
        this.#holdsCopies = false;
      }
      c.active = null;
      release();
    }
  }

  #result(mode: Mode, rows: Row[]): RunResult | Row | Row[] | undefined {
    if (mode === "all") return rows;
    if (mode === "get") return rows[0];
    const { s, db } = this.#c;
    return {
      changes: Number(s.sqlite3_changes64(db)),
      lastInsertRowid: toNumber(s.sqlite3_last_insert_rowid(db)),
    };
  }

  #bind(params: BindParams | undefined): void {
    const n = this.#paramCount;
    if (params === undefined) {
      if (n !== 0) throw usage("bind-count", `expected ${n} parameter(s), got none`, this.sql);
      return;
    }
    if (Array.isArray(params)) {
      if (params.length !== n) {
        throw usage("bind-count", `expected ${n} parameter(s), got ${params.length}`, this.sql);
      }
      for (let i = 0; i < n; i++) this.#bindValue(i + 1, params[i], i + 1);
      return;
    }
    const named = params as Readonly<Record<string, BindValue>>;
    const seen = new Set<number>();
    for (const key of Object.keys(named)) {
      const index = this.#parameterIndex(key);
      if (index === 0) throw usage("bind-name", `no parameter named ${key}`, this.sql);
      seen.add(index);
      this.#bindValue(index, named[key], key);
    }
    if (seen.size !== n) {
      throw usage("bind-count", `expected ${n} parameter(s), got ${seen.size} distinct name(s)`, this.sql);
    }
  }

  #parameterIndex(key: string): number {
    this.#names ??= new Map();
    const cached = this.#names.get(key);
    if (cached !== undefined) return cached;
    const s = this.#c.s;
    const first = key[0];
    const candidates = first === ":" || first === "@" || first === "$"
      ? [key]
      : [":", "@", "$"].map((p) => p + key);
    let index = 0;
    for (const name of candidates) {
      index = s.sqlite3_bind_parameter_index(this.#stmt, cString(name));
      if (index !== 0) break;
    }
    this.#names.set(key, index);
    return index;
  }

  #bindValue(i: number, v: BindValue | undefined, at: string | number): void {
    const s = this.#c.s;
    const stmt = this.#stmt;
    let rc: number;
    if (v === null) {
      rc = s.sqlite3_bind_null(stmt, i);
    } else if (typeof v === "number") {
      // int32 values take the cheap path; i64 parameters cross the FFI boundary as bigint.
      rc = (v | 0) === v && !Object.is(v, -0)
        ? s.sqlite3_bind_int(stmt, i, v)
        : Number.isSafeInteger(v)
        ? s.sqlite3_bind_int64(stmt, i, BigInt(v))
        : s.sqlite3_bind_double(stmt, i, v);
    } else if (typeof v === "string") {
      if (v.length === 0) {
        rc = s.sqlite3_bind_text(stmt, i, EMPTY_TEXT, 0, SQLITE_TRANSIENT);
      } else {
        const bytes = encoder.encode(v);
        rc = s.sqlite3_bind_text(stmt, i, bytes, bytes.length, SQLITE_TRANSIENT);
        this.#holdsCopies = true;
      }
    } else if (typeof v === "bigint") {
      if (v < INT64_MIN || v > INT64_MAX) {
        throw new SqliteValueError({
          reason: "integer-out-of-range",
          at,
          detail: `${v} is outside the signed 64-bit range`,
          sql: this.sql,
        });
      }
      rc = s.sqlite3_bind_int64(stmt, i, v);
    } else if (typeof v === "boolean") {
      rc = s.sqlite3_bind_int(stmt, i, v ? 1 : 0);
    } else if (ArrayBuffer.isView(v)) {
      if (v.byteLength === 0) {
        rc = s.sqlite3_bind_zeroblob(stmt, i, 0);
      } else {
        const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        rc = s.sqlite3_bind_blob(stmt, i, bytes, bytes.length, SQLITE_TRANSIENT);
        this.#holdsCopies = true;
      }
    } else {
      throw new SqliteValueError({
        reason: "unsupported-bind-type",
        at,
        detail: `cannot bind a value of type ${v === undefined ? "undefined" : typeof v}`,
        sql: this.sql,
      });
    }
    if (rc !== SQLITE_OK) throw sqliteError(this.#c, "bind", rc, this.sql);
  }

  #columnNames(): string[] {
    // Cached until SQLite re-prepares the statement (after a schema change `SELECT *` can return
    // different columns); the re-prepare counter is one cheap call per execution.
    const s = this.#c.s;
    const epoch = s.sqlite3_stmt_status(this.#stmt, SQLITE_STMTSTATUS_REPREPARE, 0);
    if (this.#columns !== null && epoch === this.#columnsEpoch) return this.#columns;
    const n = s.sqlite3_column_count(this.#stmt);
    const names = new Array<string>(n);
    for (let i = 0; i < n; i++) names[i] = readCString(s.sqlite3_column_name(this.#stmt, i));
    this.#columns = names;
    this.#columnsEpoch = epoch;
    return names;
  }

  #readRow(names: string[]): Row {
    const s = this.#c.s;
    const stmt = this.#stmt;
    const row: Row = Object.create(null);
    for (let i = 0; i < names.length; i++) {
      const type = s.sqlite3_column_type(stmt, i);
      let value: SqlValue;
      if (type === SQLITE_INTEGER) {
        // The double conversion is exact for every safe integer and lands outside the safe range
        // for every other int64, so it decides safety without allocating a bigint.
        const asDouble = s.sqlite3_column_double(stmt, i);
        if (this.#c.readBigInts) {
          value = BigInt(s.sqlite3_column_int64(stmt, i));
        } else if (Number.isSafeInteger(asDouble)) {
          value = asDouble;
        } else {
          const raw = s.sqlite3_column_int64(stmt, i);
          throw new SqliteValueError({
            reason: "unsafe-integer",
            at: names[i],
            detail: `${raw} exceeds Number.MAX_SAFE_INTEGER; open with readBigInts`,
            sql: this.sql,
          });
        }
      } else if (type === SQLITE_FLOAT) {
        value = s.sqlite3_column_double(stmt, i);
      } else if (type === SQLITE_TEXT) {
        const p = s.sqlite3_column_text(stmt, i);
        const len = s.sqlite3_column_bytes(stmt, i);
        value = p === null || len === 0 ? "" : readText(p, len);
      } else if (type === SQLITE_BLOB) {
        const p = s.sqlite3_column_blob(stmt, i);
        const len = s.sqlite3_column_bytes(stmt, i);
        const out = new Uint8Array(len);
        if (p !== null && len > 0) new Deno.UnsafePointerView(p).copyInto(out);
        value = out;
      } else {
        value = null;
      }
      row[names[i]] = value;
    }
    return row;
  }
}
