/**
 * The Effect layer over the FFI SQLite binding: connections as scoped resources, statements as
 * Effects with binding failures in the typed channel, fiber interruption bridged to
 * `sqlite3_interrupt`, and a per-connection prepared-statement cache.
 *
 * ```ts
 * Effect.scoped(Effect.gen(function* () {
 *   const db = yield* openDatabase(file, { readOnly: true, readBigInts: true });
 *   const byId = yield* prepare(db, "SELECT body FROM docs WHERE id = ?");
 *   const row = yield* get(byId, [id]);                          // main thread, blocking
 *   const rows = yield* allAsync(yield* prepare(db, listSql), params, { timeoutMs: 250 });
 * }));                                                           // scope close: closeAsync
 * ```
 *
 * Failures. Every wrapper runs in two phases (see "Provenance" below). First it reads everything
 * the caller supplied (parameters, options, the receiver) into fresh plain values; caller code
 * (a getter, a proxy trap) runs only then, and anything it throws is a defect carrying the original
 * value, untouched. Then the binding runs on those values and runs no caller code, so a binding
 * error (`SqliteFfiError`) from it is the binding's own: a typed failure. Anything else it throws
 * is a defect.
 *
 * Interruption. The async wrappers give the binding an `AbortSignal` and abort it when the fiber
 * is interrupted (an `Effect.timeout`, a `Fiber.interrupt`, a closing scope); the binding answers
 * with `sqlite3_interrupt` until its step returns. The interruption completes only after the
 * binding's execution has settled and released the connection, so the next statement on that
 * connection never fails `"busy"` because of an execution its fiber already gave up on. An
 * interrupted fiber's exit is an interruption (`Effect.timeout` reports `TimeoutException`); the
 * typed `SqliteCancelled({ reason: "deadline" })` comes from the `timeoutMs` option, which the
 * binding enforces itself.
 *
 * See `README.md` in this directory for the statement cache's contract.
 */
import { Cause, Effect, type Scope } from "effect";
import {
  type BindParams,
  type BindValue,
  Database,
  type ExecOptions,
  type OpenOptions,
  type Row,
  type RunResult,
  Statement,
} from "./database.ts";
import {
  SqliteCancelled,
  SqliteError,
  type SqliteFfiError,
  SqliteLibraryError,
  SqliteUsageError,
  SqliteValueError,
} from "./errors.ts";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
//
// A binding error's class proves nothing about where it was thrown: caller code can throw a binding
// error it caught earlier, or construct one, frozen or not. So origin is decided by *when* the throw
// happens, and the thrown value is never inspected to decide it:
//
// 1. Snapshot. Caller code may run: parameter and option getters, proxy traps, array accessors.
//    The wrapper reads each input exactly once into a value the binding consumes without running
//    caller code: a parameter list into a fresh array, named parameters into a fresh null-prototype
//    object, an `ArrayBufferView` into a fresh `Uint8Array` over the same bytes (read through the
//    view's internal slots), `timeoutMs` and the open options into fresh objects. It also checks
//    the receiver (`admit`). Anything thrown here is a defect carrying the thrown value.
// 2. Binding. The binding's own methods, taken from its class prototypes and never looked up on
//    the instance, run on the snapshot. With plain inputs, the wrapper's own `AbortSignal` and a
//    pinned `sql` (`admit`), nothing the binding does reaches caller code, so a binding error thrown
//    now is the binding's: a typed failure. Any other value is a defect.
//
// Out of scope: code that patches built-ins or the binding's prototypes changes what "the binding's
// own code" is, for every caller at once.

/** True for a value whose class is one of the binding's errors. Never throws, even on a proxy. */
export function isSqliteFfiError(e: unknown): e is SqliteFfiError {
  try {
    return e instanceof SqliteError || e instanceof SqliteCancelled || e instanceof SqliteUsageError ||
      e instanceof SqliteValueError || e instanceof SqliteLibraryError;
  } catch {
    return false;
  }
}

/**
 * A defect carrying `thrown` exactly. Not `Effect.die`: that tests `spanSymbol in thrown`, which runs
 * a proxy's `has` trap, and inside a span it replaces the value with a proxy that records the span.
 */
function defect(thrown: unknown): Effect.Effect<never> {
  return Effect.failCause(Cause.die(thrown));
}

/**
 * Classify a value thrown in the binding phase: a binding error as a typed failure, anything else
 * as a defect carrying the original value. Never used for the snapshot phase, whose throws are
 * always defects.
 */
function fromBinding(e: unknown): Effect.Effect<never, SqliteFfiError> {
  return isSqliteFfiError(e) ? Effect.fail(e) : defect(e);
}

/** A blocking wrapper: `input` takes the snapshot (phase 1), `call` runs the binding on it (phase 2). */
function twoPhase<I, A>(input: () => I, call: (snapshot: I) => A): Effect.Effect<A, SqliteFfiError> {
  return Effect.suspend(() => {
    let snapshot: I;
    try {
      snapshot = input();
    } catch (e) {
      return defect(e);
    }
    try {
      return Effect.succeed(call(snapshot));
    } catch (e) {
      return fromBinding(e);
    }
  });
}

/** The getter `key` of `proto`, to call on a receiver without consulting the receiver's own properties. */
function intrinsicGetter(proto: object, key: PropertyKey): (this: unknown) => unknown {
  return Object.getOwnPropertyDescriptor(proto, key)!.get!;
}

const statementParameterCount = intrinsicGetter(Statement.prototype, "parameterCount");
const statementIsFinalized = intrinsicGetter(Statement.prototype, "isFinalized");
const databaseInFlight = intrinsicGetter(Database.prototype, "inFlight");
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = intrinsicGetter(typedArrayPrototype, Symbol.toStringTag);
const typedArrayBuffer = intrinsicGetter(typedArrayPrototype, "buffer");
const typedArrayByteOffset = intrinsicGetter(typedArrayPrototype, "byteOffset");
const typedArrayByteLength = intrinsicGetter(typedArrayPrototype, "byteLength");
const dataViewBuffer = intrinsicGetter(DataView.prototype, "buffer");
const dataViewByteOffset = intrinsicGetter(DataView.prototype, "byteOffset");
const dataViewByteLength = intrinsicGetter(DataView.prototype, "byteLength");

/** Statements whose `sql` this layer has made read-only (see `admit`). */
const pinned = new WeakSet<Statement>();

/**
 * Phase 1 for a statement receiver; returns its parameter count. The binding's own getter reads a
 * private field, so anything `Database.prepare` did not create (a look-alike, a proxy) throws
 * `TypeError` without running a trap. The binding reads one public property of its own, `sql` (into
 * the errors it builds), and an async execution spans event-loop turns, so the first time this
 * layer sees a statement it makes `sql` read-only and non-configurable, as its type already
 * declares: no caller code can later turn it into a getter that runs inside the binding. A `sql`
 * that is already an accessor is a defect.
 */
function admit(statement: Statement): number {
  const n = statementParameterCount.call(statement) as number;
  if (!pinned.has(statement)) {
    const sql = Object.getOwnPropertyDescriptor(statement, "sql");
    if (sql === undefined || !("value" in sql)) {
      throw new TypeError("Statement.sql is no longer a data property");
    }
    Object.defineProperty(statement, "sql", { writable: false, configurable: false });
    pinned.add(statement);
  }
  return n;
}

/**
 * Phase 1 for bind parameters: read once into values the binding consumes without running caller
 * code. So every getter runs before the binding starts, including ones the binding would not have
 * reached after an earlier parameter failed. `n` is the statement's parameter count: a list of the
 * wrong length is not read, and the binding reports `"bind-count"` from the copy's length.
 */
function snapshotParams(params: BindParams | undefined, n: number): BindParams | undefined {
  if (params === null || (typeof params !== "object" && typeof params !== "function")) {
    return params; // undefined, or a non-object the binding inspects without running caller code
  }
  if (Array.isArray(params)) {
    const length: unknown = params.length;
    // Only a proxy can report something other than a valid array length, and that is a defect:
    // `new Array` throws `RangeError` for a bad number, and a non-number would become an element.
    if (typeof length !== "number") throw new TypeError("array parameters report a non-numeric length");
    if (length !== n) return new Array<BindValue>(length);
    const copy: BindValue[] = [];
    for (let i = 0; i < n; i++) copy.push(snapshotValue(params[i]));
    return copy;
  }
  const named = params as Readonly<Record<string, BindValue>>;
  const copy: Record<string, BindValue> = Object.create(null);
  for (const key of Object.keys(named)) copy[key] = snapshotValue(named[key]);
  return copy;
}

/**
 * One parameter value. Primitives pass as they are, and so do objects the binding rejects as an
 * unsupported type, which it decides from `typeof` alone. A view's `buffer` / `byteOffset` /
 * `byteLength` would be property reads on the caller's object, so a view becomes a fresh
 * `Uint8Array` over the same bytes, read through its internal slots.
 */
function snapshotValue(v: BindValue | undefined): BindValue {
  if (typeof v !== "object" || v === null || !ArrayBuffer.isView(v)) return v as BindValue;
  const typed = typedArrayTag.call(v) !== undefined;
  const byteLength = (typed ? typedArrayByteLength : dataViewByteLength).call(v) as number;
  if (byteLength === 0) return new Uint8Array(0);
  return new Uint8Array(
    (typed ? typedArrayBuffer : dataViewBuffer).call(v) as ArrayBufferLike,
    (typed ? typedArrayByteOffset : dataViewByteOffset).call(v) as number,
    byteLength,
  );
}

/**
 * A number option, read once. The binding rejects a non-number with a typed `"invalid-option"` whose
 * detail renders the value; rendering an object runs caller code (`toString`), so it happens here and
 * the binding receives, and rejects, the string.
 */
function snapshotNumber(v: unknown): unknown {
  return v !== null && (typeof v === "object" || typeof v === "function") ? String(v) : v;
}

/** A string input (path, SQL text): anything else is a defect, without running caller code. */
function requireString(v: unknown, what: string): string {
  if (typeof v !== "string") throw new TypeError(`${what} must be a string, got ${typeof v}`);
  return v;
}

function snapshotOpenOptions(options: OpenOptions | undefined): OpenOptions | undefined {
  if (options === null || (typeof options !== "object" && typeof options !== "function")) return options;
  const { readOnly, create, uri, busyTimeoutMs, readBigInts, libraryPath } = options;
  return {
    readOnly,
    create,
    uri,
    busyTimeoutMs: snapshotNumber(busyTimeoutMs) as number | undefined,
    readBigInts,
    libraryPath: libraryPath === undefined ? undefined : requireString(libraryPath, "libraryPath"),
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * Open a connection for the life of the current scope. The release runs `closeAsync`: it cancels
 * an async execution still in flight, waits for its step to return, finalizes every statement
 * (cached ones included) and closes. A close that SQLite refuses is a defect, as a throwing
 * `DatabaseSync.close` in a release is today.
 */
export function openDatabase(
  path: string,
  options?: OpenOptions,
): Effect.Effect<Database, SqliteFfiError, Scope.Scope> {
  return Effect.acquireRelease(
    twoPhase(
      () => ({ path: requireString(path, "path"), options: snapshotOpenOptions(options) }),
      (snapshot) => Database.open(snapshot.path, snapshot.options),
    ),
    (db) => Effect.promise(() => Database.prototype.closeAsync.call(db)),
  );
}

/** `Database.exec`: zero or more statements, no parameters, no results, on the main thread. */
export function exec(db: Database, sql: string): Effect.Effect<void, SqliteFfiError> {
  return twoPhase(() => requireString(sql, "sql"), (text) => Database.prototype.exec.call(db, text));
}

/** `prepareCached` as an Effect. */
export function prepare(db: Database, sql: string): Effect.Effect<Statement, SqliteFfiError> {
  return twoPhase(() => requireString(sql, "sql"), (text) => prepareCached(db, text));
}

// ---------------------------------------------------------------------------
// Statements: blocking (main thread) and nonblocking (pool thread, interruptible)
// ---------------------------------------------------------------------------

type Mode = "run" | "get" | "all";

function blocking<A>(
  statement: Statement,
  params: BindParams | undefined,
  mode: Mode,
): Effect.Effect<A, SqliteFfiError> {
  return twoPhase(
    () => snapshotParams(params, admit(statement)),
    (snapshot) =>
      (Statement.prototype[mode] as (this: Statement, p?: BindParams) => A).call(statement, snapshot),
  );
}

/** `Statement.run` on the main thread. */
export function run(statement: Statement, params?: BindParams): Effect.Effect<RunResult, SqliteFfiError> {
  return blocking<RunResult>(statement, params, "run");
}

/** `Statement.get` on the main thread. */
export function get(
  statement: Statement,
  params?: BindParams,
): Effect.Effect<Row | undefined, SqliteFfiError> {
  return blocking<Row | undefined>(statement, params, "get");
}

/** `Statement.all` on the main thread. */
export function all(statement: Statement, params?: BindParams): Effect.Effect<Row[], SqliteFfiError> {
  return blocking<Row[]>(statement, params, "all");
}

/** Bounds on a nonblocking execution, beyond the fiber's own interruption. */
export interface AsyncOptions {
  /**
   * The binding's deadline, in ms from the start: at expiry it interrupts the statement and the
   * Effect fails `SqliteCancelled({ reason: "deadline" })`.
   */
  readonly timeoutMs?: number;
}

/** `Statement.runAsync`: each step on a pool thread; interruption aborts the execution. */
export function runAsync(
  statement: Statement,
  params?: BindParams,
  options?: AsyncOptions,
): Effect.Effect<RunResult, SqliteFfiError> {
  return nonblocking<RunResult>(statement, params, options, "runAsync");
}

/** `Statement.getAsync`: each step on a pool thread; interruption aborts the execution. */
export function getAsync(
  statement: Statement,
  params?: BindParams,
  options?: AsyncOptions,
): Effect.Effect<Row | undefined, SqliteFfiError> {
  return nonblocking<Row | undefined>(statement, params, options, "getAsync");
}

/** `Statement.allAsync`: each step on a pool thread; interruption aborts the execution. */
export function allAsync(
  statement: Statement,
  params?: BindParams,
  options?: AsyncOptions,
): Effect.Effect<Row[], SqliteFfiError> {
  return nonblocking<Row[]>(statement, params, options, "allAsync");
}

const ignore = () => {};

/**
 * The interruption bridge. When the Effect runs it takes the snapshot (phase 1: a throw is a
 * defect), then starts the binding's execution on it with a fresh `AbortController`'s signal. Its
 * promise settles only after the binding has reset the statement and released the connection, so
 * resuming from it never runs ahead of the binding. On interruption the canceler aborts the
 * controller (the binding's listener records the cancel and calls `sqlite3_interrupt` while a step
 * is outstanding; nothing here touches the connection) and then waits for that same promise, so the
 * interruption is not complete until the connection is free. Nothing here throws into the binding:
 * `abort()` runs only the binding's own listener.
 */
function nonblocking<A>(
  statement: Statement,
  params: BindParams | undefined,
  options: AsyncOptions | undefined,
  mode: `${Mode}Async`,
): Effect.Effect<A, SqliteFfiError> {
  return Effect.async<A, SqliteFfiError>((resume) => {
    let input: BindParams | undefined;
    let timeoutMs: number | undefined;
    try {
      input = snapshotParams(params, admit(statement));
      timeoutMs = snapshotNumber(options?.timeoutMs) as number | undefined;
    } catch (e) {
      resume(defect(e));
      return;
    }
    const controller = new AbortController();
    const method = Statement.prototype[mode] as (
      this: Statement,
      p: BindParams | undefined,
      o: ExecOptions,
    ) => Promise<A>;
    let execution: Promise<A>;
    try {
      // Both keys are own properties, so the binding's reads never reach a prototype.
      execution = method.call(statement, input, { signal: controller.signal, timeoutMs });
    } catch (e) {
      // The binding's async methods report through the promise; this is belt and braces.
      resume(fromBinding(e));
      return;
    }
    execution.then((value) => resume(Effect.succeed(value)), (e) => resume(fromBinding(e)));
    return Effect.promise(() => {
      try {
        controller.abort();
      } catch {
        // A listener exception is reported by the event target, never thrown here; belt and braces.
      }
      return execution.then(ignore, ignore);
    });
  });
}

// ---------------------------------------------------------------------------
// Prepared-statement cache
// ---------------------------------------------------------------------------

/** Statements kept per connection by `prepareCached`. */
export const STATEMENT_CACHE_CAPACITY = 64;

/**
 * SQL that `prepareCached` never keeps: `VACUUM` (including `VACUUM INTO`) and schema or
 * connection DDL (`CREATE`, `ALTER`, `DROP`, `PRAGMA`), after leading whitespace and comments.
 * These run rarely, often change the schema the cached statements were compiled against, and
 * would only occupy slots.
 */
const UNCACHED = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:VACUUM|CREATE|ALTER|DROP|PRAGMA)\b/i;

/** Whether `prepareCached` keeps a statement for `sql`. */
export function isCacheable(sql: string): boolean {
  return !UNCACHED.test(sql);
}

interface StatementCache {
  /** SQL text → statement, least recently used first (Map iteration order). */
  readonly entries: Map<string, Statement>;
  /** The most recently used key: a repeat of it skips the reorder. */
  mru: string | undefined;
  /** Uncached statements handed out, finalized at the next idle `prepareCached` call. */
  readonly oneShots: Statement[];
}

const caches = new WeakMap<Database, StatementCache>();

/**
 * A prepared statement for `sql` on `db`, through a bounded per-connection LRU cache: the
 * replacement for `node:sqlite`'s per-call `prepare(sql.text)` that keeps the binding's
 * reused-statement point-read cost.
 *
 * - Cacheable SQL (see `isCacheable`): the cached statement, prepared on a miss. A miss beyond
 *   `STATEMENT_CACHE_CAPACITY` entries finalizes the least recently used statement. The returned
 *   statement stays valid until that many other distinct texts have been prepared after it.
 * - Other SQL: a fresh statement that is valid until the next `prepareCached` call on `db`, which
 *   finalizes it. Use it at once.
 *
 * Finalization never touches a statement with an execution in flight: it is skipped while
 * `db.inFlight` and done at a later call. (A miss cannot evict then anyway: `prepare` fails `"busy"`
 * while an execution holds the connection.) A statement finalized behind the cache's back, or by
 * `db.close()`, is dropped and prepared again; on a closed connection that fails `"closed"`. Using
 * an evicted statement fails `SqliteUsageError("finalized")`; nothing native is touched.
 *
 * Calls on `db` and on cached statements go through the binding's prototypes, never through
 * properties of the instances, which the caller holds and could shadow.
 */
export function prepareCached(db: Database, sql: string): Statement {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = { entries: new Map(), mru: undefined, oneShots: [] };
    caches.set(db, cache);
  }
  if (cache.oneShots.length > 0 && !databaseInFlight.call(db)) {
    for (const st of cache.oneShots) Statement.prototype.finalize.call(st);
    cache.oneShots.length = 0;
  }
  const { entries } = cache;
  const hit = entries.get(sql);
  if (hit !== undefined) {
    if (!statementIsFinalized.call(hit)) {
      if (cache.mru !== sql) {
        entries.delete(sql);
        entries.set(sql, hit);
        cache.mru = sql;
      }
      return hit;
    }
    entries.delete(sql);
    if (cache.mru === sql) cache.mru = undefined;
  }
  if (!isCacheable(sql)) {
    const st = Database.prototype.prepare.call(db, sql);
    cache.oneShots.push(st);
    return st;
  }
  const st = Database.prototype.prepare.call(db, sql);
  entries.set(sql, st);
  cache.mru = sql;
  // `prepare` just succeeded, so the connection is idle; the check keeps the rule local.
  while (entries.size > STATEMENT_CACHE_CAPACITY && !databaseInFlight.call(db)) {
    const [oldest, evicted] = entries.entries().next().value!;
    entries.delete(oldest);
    Statement.prototype.finalize.call(evicted);
  }
  return st;
}
