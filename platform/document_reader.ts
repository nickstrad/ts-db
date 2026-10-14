/**
 * Server-side document reads. One read-only SQLite connection and read transaction per
 * handler; no Storage semaphore, native DuckDB import, or IPC for document queries.
 * A per-call connection bounds lifetime and isolates concurrent/yielding handlers.
 *
 * Connections are the FFI binding's (`platform/sqlite_ffi/`) on `Config.sqlite.library`, opened with
 * `readBigInts` so every INTEGER reads as `bigint` (`decode` narrows them). Statements come from the
 * connection's cache (`prepareCached`) and are used in the step that fetched them.
 *
 * Each select takes the path its plan's class gives it (`classify`, FFI-05). A primary-key lookup
 * runs on the blocking path (main thread, microseconds). Anything else (`find`, `count`, `countBy`)
 * runs `allAsync` on Deno's blocking pool under `Config.sqlite.statementDeadlineMs`: at the deadline
 * the binding interrupts the statement and the query fails `StatementDeadlineError` (HTTP 504). The
 * call's `Effect.timeoutFail` at `reader.callTimeoutMs` stays as the last-resort guard; config
 * validation keeps the statement deadline below it, so the statement's own deadline fires first.
 * `ConnectionGate` (`platform/sqlite.ts`) keeps one statement at a time on the connection and owns
 * the interrupt grace period.
 */
import { allAsync, Database, isSqliteFfiError, prepareCached, type Row } from "./sqlite_ffi/mod.ts";
import { classify, pathOf } from "./sqlite_ffi/classify.ts";
import {
  ConnectionGate,
  deadlineKind,
  POISONED_DETAIL,
  sqliteFailureMessage,
  type StatementLimits,
  STUCK_STATEMENT_PHASE,
  toDeadlineError,
} from "./sqlite.ts";
import { isAbsolute } from "node:path";
import { Cause, Clock, Effect, Exit, FiberId, FiberRef, HashMap, Layer, Option } from "effect";
import {
  ContextExpiredError,
  HandlerKindMismatch,
  IpcError,
  type QueryError,
  QueryWriteAttemptError,
  QueueFullError,
  ReaderError,
  type StatementDeadlineError,
  UnknownHandlerError,
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
import type { SQL } from "../core/compile/dialect.ts";
import { decode } from "../core/compile/decode.ts";
import type { Schema } from "../core/schema.ts";
import { Documents, type Execute, type SelectPlan } from "../sdk/db.ts";
import type { AnyDefinition } from "../sdk/functions.ts";
import {
  type App,
  AppRegistry,
  Config,
  EventSink,
  ReaderClient,
  type ServerReaderClientService,
} from "./services.ts";
import { DEFAULT_READER_CAP } from "./ipc.ts";
import { currentTraceContext, isTraceToken } from "./http/trace.ts";
import { parseTenantId } from "./tenants/registry.ts";

/**
 * Allow 32 active document handlers: enough overlap for millisecond point lookups,
 * while bounding fibers cycling through blocking SQLite calls. This event-loop
 * scheduling bound is an implementation detail, not deployment configuration:
 * raising it risks starvation and lowering it adds queueing latency. The separate
 * 1000-pending admission cap remains the public backpressure contract.
 */
export const DOCUMENT_READ_CONCURRENCY_CAP = 32;

function native<A>(operation: ReaderError["operation"], run: () => A, table?: string, file?: string) {
  return Effect.try({
    try: run,
    catch: (cause) => new ReaderError({ operation, table, detail: messageOf(cause, file), cause }),
  });
}

/**
 * `native`, but the driver call runs now, in the caller's step, and only its outcome is an Effect:
 * what `ConnectionGate.blocking` requires, so nothing can claim the connection between the gate's
 * idle check and the call.
 */
function nativeNow<A>(
  operation: ReaderError["operation"],
  run: () => A,
  table?: string,
  file?: string,
): Effect.Effect<A, ReaderError> {
  try {
    return Effect.succeed(run());
  } catch (cause) {
    return Effect.fail(new ReaderError({ operation, table, detail: messageOf(cause, file), cause }));
  }
}

interface QueryContext {
  active: boolean;
  operations: number;
  readonly startNanos: bigint;
  readonly queueWaitMs: number;
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

/** A query handler's failures: the read-path union plus a deadline it let propagate (FFI-05). */
type DocumentQueryError = QueryError | StatementDeadlineError;

function isQueryError(error: unknown): error is DocumentQueryError {
  if (typeof error !== "object" || error === null) return false;
  const tag = (error as { _tag?: unknown })._tag;
  return typeof tag === "string" &&
    (Object.hasOwn(QUERY_ERROR_TAGS, tag) || tag === "StatementDeadlineError");
}

function messageOf(cause: unknown, file?: string): string {
  if (isSqliteFfiError(cause)) return sqliteFailureMessage(cause, file);
  return cause instanceof Error ? cause.message : String(cause);
}

function elapsedMs(startNanos: bigint, endNanos: bigint): number {
  return Number(endNanos - startNanos) / 1e6;
}

/** Run a registered query against a trusted, writer-prepared file. */
export function querySqlite(
  app: Pick<App, "id" | "file" | "schema">,
  definition: AnyDefinition,
  args: unknown,
) {
  return Effect.gen(function* () {
    const { logging, sqlite } = yield* Config;
    const sink = yield* EventSink;
    const pid = Deno.pid;
    return yield* Effect.acquireUseRelease(
      native(
        "open",
        () => Database.open(app.file, { readOnly: true, readBigInts: true, libraryPath: sqlite.library }),
        undefined,
        app.file,
      ),
      (connection) =>
        Effect.gen(function* () {
          const gate = new ConnectionGate(connection);
          const limits: StatementLimits = {
            deadlineMs: sqlite.statementDeadlineMs,
            graceMs: sqlite.statementInterruptGraceMs,
          };
          /** The shared envelope. `traceId` comes from the request's log annotation, as `logger.ts` does. */
          const envelope = (level: Level): Effect.Effect<EventEnvelope> =>
            Effect.gen(function* () {
              const annotations = yield* FiberRef.get(FiberRef.currentLogAnnotations);
              const traced = Option.getOrUndefined(HashMap.get(annotations, "traceId"));
              const traceId = typeof traced === "string" && traced !== ""
                ? traced
                : FiberId.threadName(yield* Effect.fiberId);
              const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
              return {
                eventId: crypto.randomUUID(),
                ts,
                level,
                role: "server",
                pid,
                traceId,
                appId: app.id,
                spanId: Option.getOrUndefined(Option.filter(
                  HashMap.get(annotations, "spanId"),
                  (value): value is string => typeof value === "string",
                )),
              };
            });

          const poisoned = (operation: ReaderError["operation"], table?: string) =>
            new ReaderError({ operation, table, detail: POISONED_DETAIL });

          /** The `error`-level `lifecycle` event of a step that outlived its interrupt (see `ConnectionGate`). */
          const stuck = (plan: SelectPlan, sqlText: string): Effect.Effect<void> =>
            Effect.flatMap(envelope("error"), (env) =>
              sink.emit(lifecycleEvent({
                ...env,
                phase: STUCK_STATEMENT_PHASE,
                detail: {
                  engine: "sqlite",
                  role: "document-reader",
                  file: app.file,
                  table: plan.table,
                  statementKind: deadlineKind(plan),
                  sqlText,
                  path: "nonblocking",
                  deadlineMs: limits.deadlineMs,
                  graceMs: limits.graceMs,
                },
              })));

          /**
           * One select on its plan's path. Blocking: fetched and run in the step that saw the
           * connection idle. Nonblocking: `allAsync` under the binding's own deadline, mapped to
           * `StatementDeadlineError` when it fires; every other binding failure is a `ReaderError`.
           */
          const runSelect = (plan: SelectPlan, sql: SQL) => {
            const { values } = sql;
            if (pathOf(classify(plan)) === "blocking") {
              return gate.blocking(() =>
                gate.poisoned
                  ? Effect.fail(poisoned("select", plan.table))
                  : nativeNow("select", () => prepareCached(connection, sql.text).all(values), plan.table)
              );
            }
            return gate.nonblocking<Row[], ReaderError>({
              sql: sql.text,
              guard: () => gate.poisoned ? poisoned("select", plan.table) : undefined,
              execute: (statement) => allAsync(statement, values, { timeoutMs: limits.deadlineMs }),
              limits,
              onStuck: stuck(plan, sql.text),
            }).pipe(
              Effect.mapError((failure): ReaderError | StatementDeadlineError =>
                !isSqliteFfiError(failure)
                  ? failure
                  : toDeadlineError(failure, plan.table, deadlineKind(plan), limits.deadlineMs) ??
                    new ReaderError({
                      operation: "select",
                      table: plan.table,
                      detail: messageOf(failure, app.file),
                      cause: failure,
                    })
              ),
            );
          };

          const select = (
            context: QueryContext,
            plan: SelectPlan,
          ): Effect.Effect<unknown, DocumentQueryError> =>
            Effect.gen(function* () {
              const sql = yield* compileSelect(app.schema, plan, "sqlite");
              context.operations += 1;
              const path = pathOf(classify(plan));
              const start = yield* Clock.currentTimeNanos;
              const exit = yield* Effect.exit(runSelect(plan, sql));
              const durationMs = elapsedMs(start, yield* Clock.currentTimeNanos);
              if (logging.traceSql || Exit.isFailure(exit)) {
                const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
                yield* sink.emit(sqlEvent({
                  ...(yield* envelope(Exit.isSuccess(exit) ? "info" : "error")),
                  engine: "sqlite",
                  dialect: "sqlite",
                  statementKind: "select",
                  tableName: plan.table,
                  sqlText: sql.text,
                  bindCount: sql.values.length,
                  bindValues: sql.values,
                  durationMs,
                  rowCount: Exit.isSuccess(exit) ? exit.value.length : undefined,
                  outcome: Exit.isSuccess(exit) ? "ok" : "error",
                  ...(Option.isSome(failure) ? fromPlatformError(failure.value) : {}),
                  path,
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
              yield* gate.blocking(() => nativeNow("begin", () => connection.exec("BEGIN TRANSACTION")));
              return { active: true, operations: 0, startNanos, queueWaitMs };
            });

          /**
           * The release half: expire the context, roll back unless `COMMIT` already ran, and record the
           * transaction. Cannot fail: a failing `ROLLBACK` is logged, and the original exit stands.
           */
          const end = (
            context: QueryContext,
            exit: Exit.Exit<unknown, DocumentQueryError>,
          ): Effect.Effect<void> =>
            Effect.gen(function* () {
              context.active = false;
              let outcome: TxOutcome = "commit";
              if (Exit.isFailure(exit)) {
                outcome = Exit.isInterrupted(exit) ? "interrupted" : "rollback";
                // Waits for a forked fiber's in-flight read; a poisoned connection is already closed.
                yield* gate.blocking(() =>
                  connection.isOpen ? nativeNow("rollback", () => connection.exec("ROLLBACK")) : Effect.void
                ).pipe(
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
                engine: "sqlite",
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
              // Preserve the existing JSON result contract before committing.
              const safe = yield* Effect.try({
                try: (): unknown => JSON.parse(JSON.stringify(result ?? null)),
                catch: (cause) =>
                  new ReaderError({
                    operation: "commit",
                    detail: `handler result is not JSON-serializable: ${messageOf(cause)}`,
                    cause,
                  }),
              });
              yield* gate.blocking(() =>
                gate.poisoned
                  ? Effect.fail(poisoned("commit"))
                  : nativeNow("commit", () => connection.exec("COMMIT"))
              );
              return safe;
            });

          return yield* Effect.acquireUseRelease(
            begin(0),
            (context) => run(definition, args, context),
            end,
          );
        }),
      // `closeAsync`: cancels and waits for an execution still in flight (a forked fiber's read), and
      // is a no-op on a connection the gate already closed.
      (connection) =>
        Effect.tryPromise({
          try: () => connection.closeAsync(),
          catch: (cause) =>
            new ReaderError({ operation: "close", detail: messageOf(cause, app.file), cause }),
        }).pipe(
          Effect.catchAll((error) => Effect.logWarning("SQLite reader close failed", error)),
        ),
    );
  });
}

/** Decorate only document calls; all other requests reach the original supervised client. */
export function makeDocumentReaderClient(ipc: ServerReaderClientService) {
  return Effect.gen(function* () {
    const config = yield* Config;
    const apps = yield* AppRegistry;
    const services = yield* Effect.context<Config | EventSink>();
    const semaphore = yield* Effect.makeSemaphore(DOCUMENT_READ_CONCURRENCY_CAP);
    let pending = 0;
    // Preserve the IPC client's observable admission contract
    // (QueueFullError{queue:"reader", cap:1000}). Admission guard only;
    // The execution semaphore below bounds admitted document handlers separately.
    const cap = DEFAULT_READER_CAP;
    const client: ServerReaderClientService = {
      call: (request) => {
        if (request.kind !== "query") return ipc.call(request);
        const query = Effect.gen(function* () {
          const app = yield* apps.get(request.appId);
          if (!Object.hasOwn(app.functions, request.name)) {
            return yield* new UnknownHandlerError({ appId: app.id, name: request.name });
          }
          const definition = app.functions[request.name];
          if (definition.kind !== "query") {
            return yield* new HandlerKindMismatch({
              appId: app.id,
              name: request.name,
              expected: "query",
              actual: definition.kind,
            });
          }
          let file = app.file;
          if (config.tenancy.mode !== "off") {
            const tenant = request.tenant;
            if (
              !tenant || typeof tenant.id !== "string" ||
              typeof tenant.file !== "string" || !isAbsolute(tenant.file)
            ) {
              return yield* new ReaderError({ operation: "open", detail: "Missing tenant context" });
            }
            yield* parseTenantId(tenant.id).pipe(
              Effect.mapError(() => new ReaderError({ operation: "open", detail: "Invalid tenant context" })),
            );
            file = tenant.file;
          }
          return yield* querySqlite({ ...app, file }, definition, request.args);
        }).pipe(
          Effect.provide(services),
          Effect.catchAllDefect((cause) =>
            Effect.zipRight(
              Effect.logError("document query handler defect", cause),
              Effect.fail(
                new ReaderError({
                  operation: "select",
                  detail: `handler defect: ${messageOf(cause)}`,
                  cause,
                }),
              ),
            )
          ),
        );
        return Effect.acquireUseRelease(
          Effect.suspend(() => {
            if (pending >= cap) {
              return Effect.fail(new QueueFullError({ queue: "reader", depth: pending, cap }));
            }
            pending++;
            return Effect.void;
          }),
          () =>
            Effect.flatMap(currentTraceContext, (current) => {
              const caller = Option.getOrUndefined(current);
              const traceId = isTraceToken(request.traceId) ? request.traceId : caller?.traceId;
              const sameTrace = traceId === caller?.traceId;
              return semaphore.withPermits(1)(query).pipe(Effect.annotateLogs({
                traceId,
                spanId: isTraceToken(request.spanId)
                  ? request.spanId
                  : sameTrace
                  ? caller?.spanId
                  : undefined,
                parentSpanId: isTraceToken(request.parentSpanId)
                  ? request.parentSpanId
                  : sameTrace
                  ? caller?.parentSpanId
                  : undefined,
              }));
            }).pipe(Effect.timeoutFail({
              duration: config.reader.callTimeoutMs,
              onTimeout: () =>
                new IpcError({ reason: "timeout", detail: "Document query deadline exceeded" }),
            })),
          () =>
            Effect.sync(() => {
              pending--;
            }),
        );
      },
    };
    return client;
  });
}

export const DocumentReaderClientLive = Layer.effect(
  ReaderClient,
  Effect.flatMap(ReaderClient, makeDocumentReaderClient),
);
