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
 * Failures. Every binding error (`SqliteFfiError`) is a typed failure. Anything else a call throws
 * came from caller code (a parameter getter, a proxy) and is a defect: the binding rethrows such
 * exceptions untouched, and so does this layer.
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
import { Effect, type Scope } from "effect";
import {
  type BindParams,
  Database,
  type OpenOptions,
  type Row,
  type RunResult,
  type Statement,
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
// Failures
// ---------------------------------------------------------------------------

/**
 * True for an error raised by the binding. Never throws: a caller's exception can be a proxy whose
 * `getPrototypeOf` trap throws, and that must not replace it.
 */
export function isSqliteFfiError(e: unknown): e is SqliteFfiError {
  try {
    return e instanceof SqliteError || e instanceof SqliteCancelled || e instanceof SqliteUsageError ||
      e instanceof SqliteValueError || e instanceof SqliteLibraryError;
  } catch {
    return false;
  }
}

/** A binding error as a typed failure, anything else as a defect carrying the original value. */
function fromThrown(e: unknown): Effect.Effect<never, SqliteFfiError> {
  return isSqliteFfiError(e) ? Effect.fail(e) : Effect.die(e);
}

/** `Effect.try` over a synchronous binding call, with caller exceptions as defects. */
function attempt<A>(f: () => A): Effect.Effect<A, SqliteFfiError> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(f());
    } catch (e) {
      return fromThrown(e);
    }
  });
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
    attempt(() => Database.open(path, options)),
    (db) => Effect.promise(() => db.closeAsync()),
  );
}

/** `Database.exec`: zero or more statements, no parameters, no results, on the main thread. */
export function exec(db: Database, sql: string): Effect.Effect<void, SqliteFfiError> {
  return attempt(() => db.exec(sql));
}

/** `prepareCached` as an Effect. */
export function prepare(db: Database, sql: string): Effect.Effect<Statement, SqliteFfiError> {
  return attempt(() => prepareCached(db, sql));
}

// ---------------------------------------------------------------------------
// Statements: blocking (main thread) and nonblocking (pool thread, interruptible)
// ---------------------------------------------------------------------------

/** `Statement.run` on the main thread. */
export function run(statement: Statement, params?: BindParams): Effect.Effect<RunResult, SqliteFfiError> {
  return attempt(() => statement.run(params));
}

/** `Statement.get` on the main thread. */
export function get(
  statement: Statement,
  params?: BindParams,
): Effect.Effect<Row | undefined, SqliteFfiError> {
  return attempt(() => statement.get(params));
}

/** `Statement.all` on the main thread. */
export function all(statement: Statement, params?: BindParams): Effect.Effect<Row[], SqliteFfiError> {
  return attempt(() => statement.all(params));
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
  return nonblocking(options, (o) => statement.runAsync(params, o));
}

/** `Statement.getAsync`: each step on a pool thread; interruption aborts the execution. */
export function getAsync(
  statement: Statement,
  params?: BindParams,
  options?: AsyncOptions,
): Effect.Effect<Row | undefined, SqliteFfiError> {
  return nonblocking(options, (o) => statement.getAsync(params, o));
}

/** `Statement.allAsync`: each step on a pool thread; interruption aborts the execution. */
export function allAsync(
  statement: Statement,
  params?: BindParams,
  options?: AsyncOptions,
): Effect.Effect<Row[], SqliteFfiError> {
  return nonblocking(options, (o) => statement.allAsync(params, o));
}

const ignore = () => {};

/**
 * The interruption bridge. The execution starts when the Effect runs, with a fresh
 * `AbortController`'s signal. Its promise settles only after the binding has reset the statement
 * and released the connection, so resuming from it never runs ahead of the binding. On
 * interruption the canceler aborts the controller (the binding's listener records the cancel and
 * calls `sqlite3_interrupt` while a step is outstanding; nothing here touches the connection) and
 * then waits for that same promise, so the interruption is not complete until the connection is
 * free. Nothing here throws into the binding: `abort()` runs only the binding's own listener.
 */
function nonblocking<A>(
  options: AsyncOptions | undefined,
  start: (o: { signal: AbortSignal; timeoutMs?: number }) => Promise<A>,
): Effect.Effect<A, SqliteFfiError> {
  return Effect.async<A, SqliteFfiError>((resume) => {
    const controller = new AbortController();
    let execution: Promise<A>;
    try {
      const timeoutMs = options?.timeoutMs;
      execution = start(
        timeoutMs === undefined ? { signal: controller.signal } : { signal: controller.signal, timeoutMs },
      );
    } catch (e) {
      // The binding's async methods report through the promise; this only guards caller getters.
      resume(fromThrown(e));
      return;
    }
    execution.then((value) => resume(Effect.succeed(value)), (e) => resume(fromThrown(e)));
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
 */
export function prepareCached(db: Database, sql: string): Statement {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = { entries: new Map(), mru: undefined, oneShots: [] };
    caches.set(db, cache);
  }
  if (cache.oneShots.length > 0 && !db.inFlight) {
    for (const st of cache.oneShots) st.finalize();
    cache.oneShots.length = 0;
  }
  const { entries } = cache;
  const hit = entries.get(sql);
  if (hit !== undefined) {
    if (!hit.isFinalized) {
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
    const st = db.prepare(sql);
    cache.oneShots.push(st);
    return st;
  }
  const st = db.prepare(sql);
  entries.set(sql, st);
  cache.mru = sql;
  // `prepare` just succeeded, so the connection is idle; the check keeps the rule local.
  while (entries.size > STATEMENT_CACHE_CAPACITY && !db.inFlight) {
    const [oldest, evicted] = entries.entries().next().value!;
    entries.delete(oldest);
    evicted.finalize();
  }
  return st;
}
