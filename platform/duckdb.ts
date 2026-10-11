/**
 * The `Reader` service: one app's SQLite file, read through DuckDB (plan item 16).
 *
 * Reader process ONLY. It deliberately never imports Node's built-in SQLite module: DuckDB's
 * `sqlite` extension and Node's SQLite would be two copies of the SQLite library in one address
 * space, which is the whole reason the reader is a second OS process (plan §0, ADR 0001).
 *
 * ## Resource lifetimes
 *
 * `ReaderLive` is `Layer.scoped`. Acquire is `DuckDBInstance` → `DuckDBConnection` →
 * `INSTALL sqlite` / `LOAD sqlite` / `ATTACH ... READ_ONLY`; each handle is registered with
 * `Effect.acquireRelease` the moment it exists, so the scope's LIFO finalizers close the connection
 * before the instance on every path — normal shutdown, a failed `ATTACH`, or an interrupt mid-setup.
 * That replaces the pre-port `catch { connection.closeSync(); instance.closeSync(); throw }`.
 *
 * ## One query = one read transaction
 *
 * `query` is `Effect.acquireUseRelease` around `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`: a failure,
 * a defect or an interruption in the handler all roll back, and every outcome emits one `tx` event.
 * The handler's `Documents` is bound to a per-query context that expires when the transaction ends;
 * using it afterwards fails `ContextExpiredError`, and any write fails `QueryWriteAttemptError`.
 * Whole queries are serialized on a `Semaphore(1)`: one DuckDB connection never interleaves two
 * transactions, whichever caller (the reader loop, or an in-process test layer) drives it.
 *
 * ## A wedged connection
 *
 * A failed `ROLLBACK` is only logged, and a transaction left open makes every later `BEGIN` fail
 * until the connection is replaced. `makeReaderPool` is the per-app cache the reader process uses:
 * it drops (and closes) a reader whose `BEGIN` failed, so the next query opens a fresh connection.
 *
 * Every compiled statement emits a `sql` event (duckdb engine and dialect) when `TRACE_SQL` is on;
 * failed statements are always emitted. Events are built with `core/events.ts`'s constructors and go
 * to `EventSink`; the envelope's `traceId` is the fiber's `traceId` log annotation, which the reader
 * loop sets per request.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  ExecutionStrategy,
  Exit,
  FiberId,
  FiberRef,
  HashMap,
  Layer,
  Option,
  Scope,
} from "effect";
import {
  ContextExpiredError,
  HandlerKindMismatch,
  type QueryError,
  QueryWriteAttemptError,
  ReaderError,
} from "../core/errors.ts";
import {
  type EventEnvelope,
  fromPlatformError,
  type Level,
  lifecycleEvent,
  sqlEvent,
  txEvent,
  type TxOutcome,
} from "../core/events.ts";
import { compileSelect } from "../core/compile/select.ts";
import { decode } from "../core/compile/decode.ts";
import { type Bind, literal, type Row } from "../core/compile/dialect.ts";
import type { Schema } from "../core/schema.ts";
import { Documents, type Execute, type SelectPlan } from "../sdk/db.ts";
import type { AnyDefinition } from "../sdk/functions.ts";
import { Config, EventSink, type EventSinkService, Reader, type ReaderService } from "./services.ts";

// ---------------------------------------------------------------------------
// The native seam
// ---------------------------------------------------------------------------

/** The slice of `DuckDBConnection` the reader uses. */
export interface DuckConnection {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string, values: Record<string, Bind>): Promise<{ getRowObjects(): Row[] }>;
  closeSync(): void;
}

/** The slice of `DuckDBInstance` the reader uses. */
export interface DuckInstance {
  connect(): Promise<DuckConnection>;
  closeSync(): void;
}

/**
 * How `ReaderLive` obtains its native instance. Production uses `duckDriver`; tests wrap it to
 * observe the order handles are opened and closed in.
 */
export interface DuckDriver {
  readonly open: () => Promise<DuckInstance>;
}

/** An in-memory DuckDB per app reader, sized as before the port. */
export const duckDriver: DuckDriver = {
  open: () => DuckDBInstance.create(":memory:", { threads: "2", memory_limit: "256MB" }),
};

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/** What one reader needs to know about its app. Structurally a subset of `services.ts`'s `App`. */
export interface ReaderApp {
  readonly id: string;
  /** Absolute path of the app's SQLite file, attached `READ_ONLY`. */
  readonly file: string;
  readonly schema: Schema;
}

/** Every `QueryError` tag, so a handler's untyped failure channel can be narrowed honestly. */
const QUERY_ERROR_TAGS: Record<QueryError["_tag"], true> = {
  SchemaError: true,
  CompileError: true,
  DecodeError: true,
  RuleError: true,
  NotFoundError: true,
  ContextExpiredError: true,
  QueryWriteAttemptError: true,
  ReaderError: true,
  QueueFullError: true,
};

function isQueryError(error: unknown): error is QueryError {
  if (typeof error !== "object" || error === null) return false;
  const tag = (error as { _tag?: unknown })._tag;
  return typeof tag === "string" && Object.hasOwn(QUERY_ERROR_TAGS, tag);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function elapsedMs(startNanos: bigint, endNanos: bigint): number {
  return Number(endNanos - startNanos) / 1e6;
}

/**
 * Runs one native call; a rejection becomes `ReaderError({ operation })` carrying the driver's message.
 *
 * There is no abort signal: interrupting the fiber abandons the promise, it does not cancel the
 * native call. For a `SELECT` that is mid-flight, the `ROLLBACK` the transaction's release issues
 * therefore runs on the *same* connection while the abandoned statement may still be executing.
 * That is safe only because DuckDB serializes statements per connection: the `ROLLBACK` queues
 * behind a statement that is already running and can never interleave with it. A statement the
 * driver has not yet started may be overtaken by the `ROLLBACK` and then run outside the
 * transaction (or inside the next query's). That is still safe because the statement is a
 * read-only `SELECT` whose result is discarded: the only observable effect is that, if the
 * overtaken statement runs inside the next query's transaction and hits a runtime error,
 * DuckDB marks that transaction aborted and the next query fails once with "Current
 * transaction is aborted". That query's own release rolls back, so there is no wedge.
 * A driver that ran statements concurrently on one connection, or allowed writes here,
 * would break this.
 */
function native<A>(
  operation: ReaderError["operation"],
  run: () => Promise<A>,
  table?: string,
): Effect.Effect<A, ReaderError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new ReaderError({ operation, table, detail: messageOf(cause), cause }),
  });
}

/** Closes a native handle; a failing close is logged, never raised — finalizers cannot fail. */
function close(what: "connection" | "instance", handle: { closeSync(): void }): Effect.Effect<void> {
  return Effect.try({
    try: () => handle.closeSync(),
    catch: (cause) => new ReaderError({ operation: "close", detail: `${what}: ${messageOf(cause)}`, cause }),
  }).pipe(Effect.catchAll((error) => Effect.logWarning("reader handle failed to close", error)));
}

/**
 * One `lifecycle` event, stamped from the Effect `Clock` like every other reader event so tests can
 * drive it with `TestClock`. Used by the reader process for `ready` / `stopping` / `failed`, and by
 * `platform/reader_layers.ts` for the event-log handle's `eventlog-*` phases.
 */
export function emitLifecycle(
  sink: EventSinkService,
  phase: string,
  detail?: unknown,
  level: "info" | "warn" | "error" = "info",
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* sink.emit(lifecycleEvent({
      eventId: crypto.randomUUID(),
      ts,
      level,
      role: "reader",
      pid: Deno.pid,
      traceId: "reader-lifecycle",
      phase,
      ...(detail === undefined ? {} : { detail }),
    }));
  });
}

/** Per-query state: the expiry flag the handler's `Documents` checks, and the statement count. */
interface QueryContext {
  active: boolean;
  operations: number;
  readonly startNanos: bigint;
  readonly queueWaitMs: number;
}

/**
 * Builds one app's reader in the current scope. Fails `ReaderError` (`"open"` for the instance,
 * connection and extension; `"attach"` for the app file) with every handle opened so far already
 * registered for release.
 */
export function makeReader(
  app: ReaderApp,
  driver: DuckDriver = duckDriver,
): Effect.Effect<ReaderService, ReaderError, Scope.Scope | Config | EventSink> {
  return Effect.gen(function* () {
    const { logging } = yield* Config;
    const sink = yield* EventSink;
    const pid = Deno.pid;

    const instance = yield* Effect.acquireRelease(
      native("open", () => driver.open()),
      (handle) => close("instance", handle),
    );
    // Registered after the instance, so it is released before it (finalizers run LIFO).
    const connection = yield* Effect.acquireRelease(
      native("open", () => instance.connect()),
      (handle) => close("connection", handle),
    );
    yield* native("open", () => connection.run("INSTALL sqlite"));
    yield* native("open", () => connection.run("LOAD sqlite"));
    yield* native(
      "attach",
      () => connection.run(`ATTACH ${literal(app.file)} AS "app" (TYPE SQLITE, READ_ONLY)`),
    );
    // The extension opens the file lazily: `ATTACH` of a missing file succeeds and the first read
    // fails. Reading the catalog here makes an unopenable file fail the layer, not the first query.
    yield* native(
      "attach",
      () => connection.run(`SELECT count(*) FROM duckdb_tables() WHERE database_name = 'app'`),
    );

    const lock = yield* Effect.makeSemaphore(1);

    /** The shared envelope. `traceId` comes from the request's log annotation, as `logger.ts` does. */
    const envelope = (level: Level): Effect.Effect<EventEnvelope> =>
      Effect.gen(function* () {
        const annotations = yield* FiberRef.get(FiberRef.currentLogAnnotations);
        const traced = Option.getOrUndefined(HashMap.get(annotations, "traceId"));
        const traceId = typeof traced === "string" && traced !== ""
          ? traced
          : FiberId.threadName(yield* Effect.fiberId);
        const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
        return { eventId: crypto.randomUUID(), ts, level, role: "reader", pid, traceId, appId: app.id };
      });

    const select = (context: QueryContext, plan: SelectPlan): Effect.Effect<unknown, QueryError> =>
      Effect.gen(function* () {
        const sql = yield* compileSelect(app.schema, plan, "duckdb");
        const parameters = Object.fromEntries(sql.values.map((value, i) => [`p${i + 1}`, value]));
        context.operations += 1;
        const start = yield* Clock.currentTimeNanos;
        // Interrupting here abandons the promise; see `native` for why the release's `ROLLBACK`
        // on this same connection is still safe.
        const exit = yield* Effect.exit(
          native(
            "select",
            async () => (await connection.runAndReadAll(sql.text, parameters)).getRowObjects(),
            plan.table,
          ),
        );
        const durationMs = elapsedMs(start, yield* Clock.currentTimeNanos);
        if (logging.traceSql || Exit.isFailure(exit)) {
          const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
          yield* sink.emit(sqlEvent({
            ...(yield* envelope(Exit.isSuccess(exit) ? "info" : "error")),
            engine: "duckdb",
            dialect: "duckdb",
            statementKind: "select",
            tableName: plan.table,
            sqlText: sql.text,
            bindCount: sql.values.length,
            bindValues: sql.values,
            durationMs,
            rowCount: Exit.isSuccess(exit) ? exit.value.length : undefined,
            outcome: Exit.isSuccess(exit) ? "ok" : "error",
            ...(Option.isSome(failure) ? fromPlatformError(failure.value) : {}),
          }, { includeBindValues: logging.includeBindValues }));
        }
        return yield* decode(app.schema, plan, yield* exit);
      });

    /** The handler's executor: reads only, and only while its transaction is open. */
    const executeIn = (context: QueryContext): Execute => (operation) =>
      Effect.suspend(() => {
        if (!context.active) return Effect.fail(new ContextExpiredError({ context: "query" }));
        if (operation.kind !== "select") {
          return Effect.fail(
            new QueryWriteAttemptError({ operation: operation.kind, table: operation.table }),
          );
        }
        return select(context, operation);
      });

    const begin = (queueWaitMs: number): Effect.Effect<QueryContext, ReaderError> =>
      Effect.gen(function* () {
        const startNanos = yield* Clock.currentTimeNanos;
        yield* native("begin", () => connection.run("BEGIN TRANSACTION"));
        return { active: true, operations: 0, startNanos, queueWaitMs };
      });

    /**
     * The release half: expire the context, roll back unless `COMMIT` already ran, and record the
     * transaction. Cannot fail: a failing `ROLLBACK` is logged, and the original exit stands.
     */
    const end = (context: QueryContext, exit: Exit.Exit<unknown, QueryError>): Effect.Effect<void> =>
      Effect.gen(function* () {
        context.active = false;
        let outcome: TxOutcome = "commit";
        if (Exit.isFailure(exit)) {
          outcome = Exit.isInterrupted(exit) ? "interrupted" : "rollback";
          yield* native("rollback", () => connection.run("ROLLBACK")).pipe(
            Effect.catchAll((error) => Effect.logWarning("reader rollback failed", error)),
          );
        }
        const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
        // A rollback with no typed failure was a defect in the handler.
        const error = Option.isSome(failure)
          ? fromPlatformError(failure.value)
          : outcome === "rollback"
          ? { errorTag: "Defect" }
          : {};
        yield* sink.emit(txEvent({
          ...(yield* envelope(outcome === "commit" ? "info" : "warn")),
          engine: "duckdb",
          outcome,
          operations: context.operations,
          durationMs: elapsedMs(context.startNanos, yield* Clock.currentTimeNanos),
          queueWaitMs: context.queueWaitMs,
          ...error,
        }));
      });

    const run = (definition: AnyDefinition, args: unknown, context: QueryContext) =>
      Effect.gen(function* () {
        const db = new Documents<Schema>(executeIn(context));
        // `AnyDefinition` erases the handler's error type; anything outside the read path's
        // union is an app bug, not a request failure, so it travels as a defect.
        const result = yield* definition.invoke(db, args).pipe(
          Effect.catchAll((error) => isQueryError(error) ? Effect.fail(error) : Effect.die(error)),
        );
        // The reply crosses a process boundary: prove it survives JSON before committing.
        const safe = yield* Effect.try({
          try: (): unknown => JSON.parse(JSON.stringify(result ?? null)),
          catch: (cause) =>
            new ReaderError({
              operation: "commit",
              detail: `handler result is not JSON-serializable: ${messageOf(cause)}`,
              cause,
            }),
        });
        yield* native("commit", () => connection.run("COMMIT"));
        return safe;
      });

    yield* Effect.logInfo("reader opened").pipe(Effect.annotateLogs({ appId: app.id }));

    return {
      query: (definition, args) =>
        Effect.gen(function* () {
          if (definition.kind !== "query") {
            // The router checks the kind before it gets here; reaching this is a platform bug.
            return yield* Effect.die(
              new HandlerKindMismatch({ appId: app.id, expected: "query", actual: definition.kind }),
            );
          }
          const queued = yield* Clock.currentTimeNanos;
          return yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const queueWaitMs = elapsedMs(queued, yield* Clock.currentTimeNanos);
              return yield* Effect.acquireUseRelease(
                begin(queueWaitMs),
                (context) => run(definition, args, context),
                end,
              );
            }),
          );
        }),
    };
  });
}

/**
 * Live: one app's reader, scoped. Fails with `ReaderError` (a `QueryError` member) when the
 * instance cannot open, the `sqlite` extension cannot load, or the app file cannot be attached.
 */
export function ReaderLive(
  app: ReaderApp,
  driver: DuckDriver = duckDriver,
): Layer.Layer<Reader, ReaderError, Config | EventSink> {
  return Layer.scoped(Reader, makeReader(app, driver));
}

/** One app's cached reader, and the child scope that owns its native handles. */
interface PooledReader {
  readonly reader: ReaderService;
  readonly scope: Scope.CloseableScope;
}

/**
 * The reader process's per-app reader cache, built in the current scope. The returned function
 * yields a `ReaderService` for an app (keyed by the `ReaderApp` object's identity); its readers
 * open lazily on the first query, each into its own child of the current scope, and close with it.
 *
 * - A failed open is not cached: the slot is invalidated, so the next query retries.
 * - A failed `BEGIN` drops the reader: its slot is invalidated and its scope closed (connection,
 *   then instance), so the next query opens a fresh connection instead of failing every `BEGIN`
 *   against a transaction a failed `ROLLBACK` left open. The query that hit it still fails.
 *
 * The reader process serves one request at a time, so nothing else is using a reader being dropped.
 */
export function makeReaderPool(
  driver: DuckDriver = duckDriver,
): Effect.Effect<(app: ReaderApp) => ReaderService, never, Scope.Scope | Config | EventSink> {
  return Effect.gen(function* () {
    const root = yield* Effect.scope;
    // Readers open lazily, inside request handling; they get the pool's own Config and sink.
    const services = yield* Effect.context<Config | EventSink>();

    // Each app's reader lives in its own child of the pool's scope: a failed open closes just
    // that child (releasing whatever it had opened), and a successful one is closed with the pool.
    const open = (app: ReaderApp): Effect.Effect<PooledReader, ReaderError> =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(root, ExecutionStrategy.sequential);
        const exit = yield* Effect.exit(
          Effect.map(Layer.buildWithScope(ReaderLive(app, driver), scope), (context) =>
            Context.get(context, Reader))
            .pipe(Effect.provide(services)),
        );
        if (Exit.isFailure(exit)) {
          yield* Scope.close(scope, exit);
        }
        return { reader: yield* exit, scope };
      });
    // `cachedFunction` memoizes failures too, so it caches a per-app *slot*: a memoized open that
    // is invalidated when it fails (or when its reader is dropped), which is what lets the next
    // request retry.
    const slotFor = yield* Effect.cachedFunction((app: ReaderApp) =>
      Effect.cachedInvalidateWithTTL(open(app), Duration.infinity)
    );

    return (app) => ({
      query: (definition, args) =>
        Effect.gen(function* () {
          const [get, invalidate] = yield* slotFor(app);
          const pooled = yield* Effect.tapError(get, () => invalidate);
          return yield* pooled.reader.query(definition, args).pipe(
            Effect.tapError((error) =>
              error._tag === "ReaderError" && error.operation === "begin"
                ? Effect.zipRight(
                  Effect.logWarning("reader dropped after a failed BEGIN", error).pipe(
                    Effect.annotateLogs({ appId: app.id }),
                  ),
                  Effect.zipRight(invalidate, Scope.close(pooled.scope, Exit.void)),
                )
                : Effect.void
            ),
          );
        }),
    });
  });
}
