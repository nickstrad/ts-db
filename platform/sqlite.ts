/**
 * The `Storage` service: the SQLite writer as a scoped Effect resource (plan item 15).
 *
 * Writer process ONLY. Never import this file into the DuckDB process — the reader must not load a
 * second copy of the SQLite library (plan §0, "The hard architectural constraint").
 *
 * ## Shape
 *
 * ```text
 *   mutation / snapshot ─> exclusive ─> Semaphore(1) ─> transaction ─> handler ─> COMMIT | ROLLBACK
 *                          depth cap 1000              acquireUseRelease
 *                          (QueueFullError)            (rollback on failure, defect, interruption)
 * ```
 *
 * Four decisions carry the item:
 *
 * 1. **Lifetime is a scope.** `makeStorage` opens the `DatabaseSync` handle with `acquireRelease`
 *    *before* it runs the pragmas and the schema transaction, so a failed startup (driver error,
 *    `SchemaDriftError`) is a scoped failure that still closes the handle. The finalizer first
 *    refuses new work, then waits for the in-flight queue to drain, and only then closes.
 * 2. **One writer at a time.** `exclusive` admits at most `WRITER_QUEUE_CAP` jobs (running plus
 *    waiting) and runs them one at a time under `Semaphore(1)`; job 1001 fails
 *    `QueueFullError({ queue: "writer" })` instead of queueing without bound. The depth counter is
 *    incremented and its decrement registered in one uninterruptible step, so an interrupted
 *    waiter cannot leak a slot.
 * 3. **The transaction cannot outlive its exit.** `transaction` is `Effect.acquireUseRelease`:
 *    `BEGIN IMMEDIATE` is the acquire, the handler plus the serializability check plus `COMMIT` is
 *    the use, and the release rolls back whenever `COMMIT` did not run — on a typed failure, a
 *    defect, or an interruption. The release also expires the handler's `Documents` handle (the
 *    mutation-context flag, checked before every statement), so a forked fiber that kept it fails
 *    `ContextExpiredError` — even one switched out mid-operation, between a select and its update.
 * 4. **Every statement is an event.** `statement` times each prepared statement and emits a `sql`
 *    event (kind, table, duration, row count, bind count, SQL text; bind values only under
 *    `LOG_INCLUDE_BIND_VALUES`); each transaction emits one `tx` event; each queue rejection emits a
 *    `queue` event. All through `core/events.ts` constructors and `EventSink`.
 *
 * Levels: a successful statement is `debug` unless `TRACE_SQL` is on (then `info`) — SQL tracing
 * stays opt-in, as it was when it went to stderr. Failed statements, interrupted transactions and
 * queue rejections are `warn`; committed and rolled-back transactions are `info`.
 *
 * `Clock` and `IdGen` are captured when the layer is built: `_creationTime` comes from Effect's
 * `Clock` (so `TestClock` drives it) and document ids from `IdGen`.
 *
 * Text containing U+0000 never crosses this boundary (plan item 31,
 * `docs/adr/0005-text-storage-contract.md`): `node:sqlite` binds it intact but truncates TEXT at the
 * NUL on read. Bodies, ids and filter values holding one fail `SchemaError` before their statement
 * runs, and a read of NUL text stored before the contract fails `StorageError` (see `nulProbe`)
 * rather than returning the truncated value.
 *
 * At the bottom, `SQLiteWriter` is a COMPATIBILITY WRAPPER with the pre-port constructor and async
 * methods, for the callers this item does not own (`platform/server.ts`, `platform/backup.ts`,
 * `tests/core_test.ts`). It is a thin adapter over `makeStorage`; items 19, 20 and 22 moved those
 * callers onto `StorageLive`. Item 26 left it in place (dead code, zero callers) — removal is a
 * follow-up.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  Cause,
  Clock as EffectClock,
  Deferred,
  Effect,
  Either,
  Exit,
  FiberId,
  Function as EffectFunction,
  HashMap,
  Layer,
  Option,
  Scope,
} from "effect";
import {
  CompileError,
  ContextExpiredError,
  DecodeError,
  type MutationError,
  NonSerializableResultError,
  NotFoundError,
  QueueFullError,
  SchemaDriftError,
  SchemaError,
  StorageError,
} from "../core/errors.ts";
import {
  type EventEnvelope,
  fromPlatformError,
  type Level,
  queueEvent,
  sqlEvent,
  type SqlStatementKind,
  txEvent,
  type TxOutcome,
} from "../core/events.ts";
import type { Schema } from "../core/schema.ts";
import { NUL, parseObject, storable } from "../core/schema.ts";
import { compileDDL } from "../core/compile/ddl.ts";
import { compileSelect, fieldNode, tableFor } from "../core/compile/select.ts";
import { compileDelete, compileInsert, compileReplace } from "../core/compile/write.ts";
import { decode } from "../core/compile/decode.ts";
import { literal, quote, type Row, type SQL } from "../core/compile/dialect.ts";
import { Documents, type Operation, type SelectPlan } from "../sdk/db.ts";
import type { AnyDefinition } from "../sdk/functions.ts";
import { formatSchemaError } from "../sdk/schema.ts";
import { ConfigTest } from "./config.ts";
import { Config, EventSink, type EventSinkService, IdGen, Storage, type StorageService } from "./services.ts";

/** Jobs admitted to the writer queue at once, running plus waiting. Unchanged from the pre-port cap. */
export const WRITER_QUEUE_CAP = 1000;

/** The pre-port drift message, kept verbatim in `SchemaDriftError.detail`. */
const DRIFT_DETAIL =
  "Schema/storage changed. MVP refuses automatic migration; use a new database or an explicit migration.";

export interface StorageOptions {
  /** Absolute path of the app's SQLite file. */
  readonly file: string;
  readonly schema: Schema;
  /** Stamped on every event this instance emits. */
  readonly appId?: string;
}

/** What a single document operation can fail with inside a mutation. A subset of `DbError`. */
type ExecuteError =
  | SchemaError
  | CompileError
  | DecodeError
  | StorageError
  | ContextExpiredError
  | MutationError;

/** One open transaction's bookkeeping. `active` is the mutation-context expiry flag. */
interface Tx {
  active: boolean;
  committed: boolean;
  operations: number;
  readonly startedNanos: bigint;
  readonly queueWaitMs: number;
}

const MUTATION_ERROR_TAGS: ReadonlySet<string> = new Set<MutationError["_tag"]>([
  "SchemaError",
  "CompileError",
  "DecodeError",
  "RuleError",
  "NotFoundError",
  "ConflictError",
  "ContextExpiredError",
  "NonSerializableResultError",
  "StorageError",
  "QueueFullError",
]);

/**
 * Handlers are typed `Effect<unknown, unknown>` once erased into `AnyDefinition`; this narrows the
 * failure back to the contract. Anything else is an app bug and becomes a defect (still rolled back).
 */
function isMutationError(e: unknown): e is MutationError {
  return e instanceof Error && MUTATION_ERROR_TAGS.has((e as { _tag?: unknown })._tag as string);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `errorTag`/`errorDetail` for a failed exit: the repo's tag when there is one, `Defect` otherwise. */
function errorColumns(cause: Cause.Cause<unknown>): { errorTag?: string; errorDetail?: unknown } {
  if (Cause.isInterruptedOnly(cause)) return { errorTag: "Interrupted" };
  const failure = Cause.squash(cause);
  if (failure instanceof Error && typeof (failure as { _tag?: unknown })._tag === "string") {
    return fromPlatformError(failure as MutationError);
  }
  return { errorTag: "Defect", errorDetail: { message: messageOf(failure) } };
}

/**
 * The stored-text probe for one compiled read (`docs/adr/0005-text-storage-contract.md`): a statement
 * over the same SQL and binds that names the first result column holding U+0000, or returns no row.
 * Text columns (`_id`, `string`/`enum` fields, a `countBy` group value) are searched with `instr`;
 * JSON text (`doc`, array fields) with `json_tree`, because the NUL is stored there as a `\u0000`
 * escape. It asks whether *any* row of the read holds one, so the outer query needs no ordering of its
 * own; the subquery's `ORDER BY ... LIMIT` still picks the same rows the read returned. `json_tree`
 * fails on malformed JSON, so a corrupt `doc` or array column (unreachable past the `json_valid`
 * CHECKs) now surfaces here as a `StorageError` rather than as `decode`'s `malformed-json`.
 * `undefined` when the read returns no text (`count`).
 */
function nulProbe(
  schema: Schema,
  plan: SelectPlan,
  sql: SQL,
): Either.Either<SQL | undefined, CompileError | SchemaError> {
  return Either.gen(function* () {
    const table = yield* tableFor(schema, plan.table);
    const checks: [string, string][] = [];
    const text = (name: string, column: string) =>
      Either.map(quote(column), (c) => checks.push([name, `instr(q.${c}, char(0)) > 0`]));
    const json = (name: string, column: string) =>
      Either.map(quote(column), (c) =>
        checks.push([
          name,
          `EXISTS (SELECT 1 FROM json_tree(q.${c}) WHERE type = 'text' AND instr(atom, char(0)) > 0)`,
        ]));
    if (plan.aggregate?.kind === "count") return undefined;
    if (plan.aggregate?.kind === "countBy") {
      const node = yield* fieldNode(table, plan.aggregate.field);
      if (node.kind === "string" || node.kind === "enum") yield* text(plan.aggregate.field, "value");
    } else {
      yield* text("_id", "_id");
      if (table.storage === "json") yield* json("doc", "doc");
      else {
        for (const [name, { node }] of Object.entries(table.fields)) {
          if (node.kind === "string" || node.kind === "enum") yield* text(name, name);
          if (node.kind === "array") yield* json(name, name);
        }
      }
    }
    if (!checks.length) return undefined;
    const cases = checks.map(([name, check]) => `WHEN ${check} THEN ${literal(name)}`).join(" ");
    return {
      text: `SELECT "field" FROM (SELECT CASE ${cases} END AS "field" FROM (${sql.text}) AS q) ` +
        'WHERE "field" IS NOT NULL LIMIT 1',
      values: sql.values,
    };
  });
}

/**
 * Builds the service inside the caller's scope. Requires `EventSink`, `IdGen` and `Config`; reads
 * `Clock` from the running fiber once, here.
 */
export function makeStorage(
  options: StorageOptions,
): Effect.Effect<
  StorageService,
  StorageError | SchemaDriftError | CompileError | SchemaError,
  Scope.Scope | EventSink | IdGen | Config
> {
  const { file, schema, appId } = options;
  return Effect.gen(function* () {
    const sink = yield* EventSink;
    const idGen = yield* IdGen;
    const { logging } = yield* Config;
    const clock = yield* Effect.clock;
    const semaphore = yield* Effect.makeSemaphore(1);
    const drained = yield* Deferred.make<void>();
    let depth = 0;
    let closing = false;

    const nanos = () => clock.unsafeCurrentTimeNanos();
    const msSince = (start: bigint) => Number(nanos() - start) / 1e6;

    const envelope = (level: Level): Effect.Effect<EventEnvelope> =>
      Effect.map(Effect.zip(Effect.logAnnotations, Effect.fiberId), ([annotations, fiberId]) => {
        const annotation = (key: string) =>
          Option.getOrUndefined(
            Option.filter(HashMap.get(annotations, key), (v): v is string => typeof v === "string"),
          );
        return {
          eventId: crypto.randomUUID(),
          ts: new Date(clock.unsafeCurrentTimeMillis()).toISOString(),
          level,
          role: "server",
          pid: Deno.pid,
          traceId: annotation("traceId") ?? FiberId.threadName(fiberId),
          spanId: annotation("spanId"),
          appId,
        };
      });

    // The handle exists before anything can fail, so every later startup failure closes it.
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new DatabaseSync(file),
        catch: (cause) => new StorageError({ operation: "open", detail: messageOf(cause), cause }),
      }),
      (db) =>
        Effect.gen(function* () {
          closing = true;
          if (depth > 0) yield* Deferred.await(drained);
          if (db.isOpen) db.close();
        }),
    );

    /**
     * One prepared statement: run, time, emit a `sql` event, map a driver throw to `StorageError`.
     * `guard`, when given, is checked in the same synchronous step as the driver call: a fiber can be
     * switched out between two statements of one operation, so checking once per operation would let
     * a forked fiber's write land after `COMMIT`.
     */
    const statement = <A, E = never>(
      kind: SqlStatementKind,
      table: string | undefined,
      sql: SQL,
      run: (prepared: StatementSync) => A,
      rows: (result: A) => number,
      operation: StorageError["operation"] = kind,
      guard?: () => E | undefined,
    ): Effect.Effect<A, StorageError | E> =>
      Effect.suspend((): Effect.Effect<A, StorageError | E> => {
        const refused = guard?.();
        if (refused !== undefined) return Effect.fail(refused);
        const started = nanos();
        let result: A;
        try {
          result = run(database.prepare(sql.text));
        } catch (cause) {
          const failure = new StorageError({ operation, table, detail: messageOf(cause), cause });
          return Effect.zipRight(
            emitSql("warn", kind, table, sql, msSince(started), undefined, failure),
            Effect.fail(failure),
          );
        }
        const level: Level = logging.traceSql ? "info" : "debug";
        return Effect.as(emitSql(level, kind, table, sql, msSince(started), rows(result)), result);
      });

    const emitSql = (
      level: Level,
      kind: SqlStatementKind,
      table: string | undefined,
      sql: SQL,
      durationMs: number,
      rowCount: number | undefined,
      failure?: StorageError,
    ): Effect.Effect<void> =>
      Effect.flatMap(envelope(level), (env) =>
        sink.emit(sqlEvent({
          ...env,
          engine: "sqlite",
          dialect: "sqlite",
          statementKind: kind,
          tableName: table,
          sqlText: sql.text,
          bindCount: sql.values.length,
          bindValues: sql.values,
          durationMs,
          rowCount,
          outcome: failure ? "error" : "ok",
          ...(failure ? fromPlatformError(failure) : {}),
        }, { includeBindValues: logging.includeBindValues })));

    const changes = (result: { changes: number | bigint }) => Number(result.changes);

    const exec = (kind: SqlStatementKind, table: string | undefined, text: string) =>
      statement(kind, table, { text, values: [] }, (s) => s.run(), changes);

    /**
     * `BEGIN IMMEDIATE` … `COMMIT`, with `ROLLBACK` on every exit that did not commit. The release
     * runs on failure, defect and interruption alike, expires the context, and emits the `tx` event.
     */
    const transaction = <A, E>(
      queueWaitMs: number,
      use: (tx: Tx) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | StorageError> =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          const startedNanos = nanos();
          try {
            database.exec("BEGIN IMMEDIATE");
          } catch (cause) {
            return Effect.fail(new StorageError({ operation: "begin", detail: messageOf(cause), cause }));
          }
          const tx: Tx = { active: true, committed: false, operations: 0, startedNanos, queueWaitMs };
          return Effect.succeed(tx);
        }),
        (tx) =>
          Effect.flatMap(use(tx), (result) =>
            Effect.suspend(() => {
              // Expire in the same step as COMMIT: the release runs later, after a possible yield.
              tx.active = false;
              try {
                database.exec("COMMIT");
              } catch (cause) {
                return Effect.fail(
                  new StorageError({ operation: "commit", detail: messageOf(cause), cause }),
                );
              }
              tx.committed = true;
              return Effect.succeed(result);
            })),
        (tx, exit) =>
          Effect.suspend(() => {
            tx.active = false;
            let rollbackFailure: unknown;
            if (!tx.committed && database.isTransaction) {
              try {
                database.exec("ROLLBACK");
              } catch (cause) {
                rollbackFailure = cause;
              }
            }
            const outcome: TxOutcome = tx.committed
              ? "commit"
              : Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)
              ? "interrupted"
              : "rollback";
            const columns = Exit.isFailure(exit) ? errorColumns(exit.cause) : {};
            const emitted = Effect.flatMap(envelope(outcome === "interrupted" ? "warn" : "info"), (env) =>
              sink.emit(txEvent({
                ...env,
                engine: "sqlite",
                outcome,
                operations: tx.operations,
                durationMs: msSince(tx.startedNanos),
                queueWaitMs: tx.queueWaitMs,
                ...columns,
              })));
            // A connection still inside a transaction would poison every later job: fail loudly.
            return rollbackFailure !== undefined && database.isTransaction
              ? Effect.zipRight(
                emitted,
                Effect.die(
                  new StorageError({
                    operation: "rollback",
                    detail: messageOf(rollbackFailure),
                    cause: rollbackFailure,
                  }),
                ),
              )
              : emitted;
          }),
      );

    /** Admit `job` to the writer queue (or reject it at the cap), then run it alone. */
    const exclusive = <A, E>(
      job: (queueWaitMs: number) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | QueueFullError | StorageError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend((): Effect.Effect<A, E | QueueFullError | StorageError> => {
          if (closing) {
            return Effect.fail(new StorageError({ operation: "close", detail: "Storage is closed" }));
          }
          if (depth >= WRITER_QUEUE_CAP) {
            const failure = new QueueFullError({ queue: "writer", depth, cap: WRITER_QUEUE_CAP });
            return Effect.zipRight(
              Effect.flatMap(envelope("warn"), (env) =>
                sink.emit(queueEvent({
                  ...env,
                  queue: "writer",
                  depth: failure.depth,
                  cap: WRITER_QUEUE_CAP,
                  event: "rejected",
                  dropped: 1,
                }))),
              Effect.fail(failure),
            );
          }
          depth++;
          const enqueued = nanos();
          return Effect.ensuring(
            restore(semaphore.withPermits(1)(Effect.suspend(() => job(msSince(enqueued))))),
            Effect.suspend(() => {
              depth--;
              return closing && depth === 0 ? Deferred.succeed(drained, undefined) : Effect.void;
            }),
          );
        })
      );

    /** The mutation-context guard for `statement`: refuses once `tx`'s release has run. */
    const live = (tx: Tx) => (): ContextExpiredError | undefined =>
      tx.active ? undefined : new ContextExpiredError({ context: "mutation" });

    const select = (plan: SelectPlan, tx: Tx) =>
      Effect.gen(function* () {
        const sql = yield* compileSelect(schema, plan, "sqlite");
        for (const filter of plan.filters) yield* storable(filter.value, filter.field);
        const rows = yield* statement(
          "select",
          plan.table,
          sql,
          (s) => s.all(...sql.values),
          (r) => r.length,
          "select",
          live(tx),
        );
        const probe = rows.length ? yield* nulProbe(schema, plan, sql) : undefined;
        if (probe) {
          const hit = yield* statement(
            "select",
            plan.table,
            probe,
            (s) => s.get(...probe.values),
            (row) => (row ? 1 : 0),
            "select",
            live(tx),
          );
          if (hit) {
            return yield* new StorageError({
              operation: "select",
              table: plan.table,
              detail: `Stored text in "${hit.field}" contains U+0000, which node:sqlite truncates on read`,
            });
          }
        }
        return yield* decode(schema, plan, rows as Row[]);
      });

    const write = <E = never>(
      kind: "insert" | "update" | "delete",
      table: string,
      sql: SQL,
      guard?: () => E | undefined,
    ) => statement(kind, table, sql, (s) => s.run(...sql.values), changes, kind, guard);

    const execute = (op: Operation, tx: Tx): Effect.Effect<unknown, ExecuteError> => {
      switch (op.kind) {
        case "select":
          return select(op, tx);
        case "insert":
          return Effect.gen(function* () {
            const id = yield* idGen.next;
            const now = yield* clock.currentTimeMillis;
            const sql = yield* compileInsert(schema, op.table, op.value, { _id: id, _creationTime: now });
            yield* storable(op.value, "");
            if (id.includes(NUL)) {
              return yield* new StorageError({
                operation: "insert",
                table: op.table,
                detail: "IdGen produced an _id containing U+0000",
              });
            }
            yield* write("insert", op.table, sql, live(tx));
            return id;
          });
        case "patch":
          return Effect.gen(function* () {
            const table = yield* tableFor(schema, op.table);
            const patch = yield* storable(yield* parseObject(table.fields, op.value, true), "");
            const found = yield* select({
              kind: "select",
              table: op.table,
              filters: [{ field: "_id", op: "eq", value: op.id }],
              limit: 1,
            }, tx);
            const old = (found as Row[])[0];
            if (!old) return yield* new NotFoundError({ table: op.table, id: op.id });
            const body = Object.fromEntries(Object.keys(table.fields).map((key) => [key, old[key]]));
            yield* write(
              "update",
              op.table,
              yield* compileReplace(schema, op.table, op.id, { ...body, ...patch }),
              live(tx),
            );
            return null;
          });
        case "delete":
          return Effect.gen(function* () {
            const sql = yield* compileDelete(schema, op.table, op.id);
            yield* storable(op.id, "_id");
            yield* write("delete", op.table, sql, live(tx));
            return null;
          });
      }
    };

    // Startup: pragmas, then the fingerprint check and DDL in one BEGIN IMMEDIATE transaction.
    yield* exec("pragma", undefined, "PRAGMA journal_mode=WAL");
    yield* exec("pragma", undefined, "PRAGMA synchronous=FULL");
    yield* exec("pragma", undefined, "PRAGMA busy_timeout=5000");
    yield* transaction(0, (tx) =>
      Effect.gen(function* () {
        const counted = <A, E>(effect: Effect.Effect<A, E>) => Effect.tap(effect, () => void tx.operations++);
        yield* counted(exec(
          "ddl",
          "_platform_schema",
          'CREATE TABLE IF NOT EXISTS "_platform_schema" (id INTEGER PRIMARY KEY CHECK (id = 1), definition TEXT NOT NULL) STRICT',
        ));
        const fingerprint = JSON.stringify(schema);
        const existing = yield* counted(statement(
          "select",
          "_platform_schema",
          { text: 'SELECT definition FROM "_platform_schema" WHERE id = 1', values: [] },
          (s) => s.get(),
          (row) => (row ? 1 : 0),
        ));
        if (existing && existing.definition !== fingerprint) {
          return yield* new SchemaDriftError({ file, detail: DRIFT_DETAIL });
        }
        for (const text of yield* compileDDL(schema)) yield* counted(exec("ddl", undefined, text));
        if (!existing) {
          yield* counted(write("insert", "_platform_schema", {
            text: 'INSERT INTO "_platform_schema" VALUES (1, ?)',
            values: [fingerprint],
          }));
        }
      }));

    const service: StorageService = {
      mutation: (definition: AnyDefinition, args: unknown) =>
        definition.kind !== "mutation"
          ? Effect.die(new Error("Expected a mutation"))
          : exclusive((queueWaitMs) =>
            transaction(queueWaitMs, (tx) => {
              const documents = new Documents<Schema>((op) =>
                Effect.suspend(() => {
                  if (!tx.active) return Effect.fail(new ContextExpiredError({ context: "mutation" }));
                  tx.operations++;
                  return execute(op, tx);
                })
              );
              return definition.invoke(documents, args).pipe(
                Effect.catchAll((e) => isMutationError(e) ? Effect.fail(e) : Effect.die(e)),
                // Catch non-JSON results before committing; transport cannot serialize them later.
                Effect.flatMap((result) =>
                  Effect.try({
                    try: (): unknown => JSON.parse(JSON.stringify(result ?? null)),
                    catch: (cause) => new NonSerializableResultError({ appId, detail: messageOf(cause) }),
                  })
                ),
              );
            })
          ),
      snapshot: (destination: string) =>
        exclusive(() =>
          // Consistent standalone backup, including committed data still in the WAL.
          // Never use copyFile(liveDatabase, backup) on a live WAL database.
          statement(
            "pragma",
            undefined,
            { text: "VACUUM INTO ?", values: [destination] },
            (s) => s.run(destination),
            changes,
            "snapshot",
          )
        ).pipe(
          Effect.asVoid,
          Effect.catchTag(
            "QueueFullError",
            (cause) =>
              Effect.fail(new StorageError({ operation: "snapshot", detail: "Writer queue full", cause })),
          ),
        ),
    };
    return service;
  });
}

/** Live: one per app. Fails with `SchemaDriftError` (startup) or `StorageError` (driver). */
export function StorageLive(
  options: StorageOptions,
): Layer.Layer<
  Storage,
  StorageError | SchemaDriftError | CompileError | SchemaError,
  EventSink | IdGen | Config
> {
  return Layer.scoped(Storage, makeStorage(options));
}

/** Live: `crypto.randomUUID()`. */
export const IdGenLive: Layer.Layer<IdGen> = Layer.succeed(IdGen, {
  next: Effect.sync(() => crypto.randomUUID()),
});

// ===========================================================================
// COMPATIBILITY WRAPPER — removed by item 26 once items 19, 20 and 22 port their callers
// ===========================================================================

export type Trace = (engine: "sqlite" | "duckdb", sql: SQL) => void;

/** Bind values on, so the legacy `trace` callback still sees them; this config never reaches a log file. */
const LEGACY_CONFIG = Effect.runSync(
  Effect.provide(Config, ConfigTest({ logging: { includeBindValues: true } })),
);

/** Feeds `sql` events to the pre-port `trace` callback (`TRACE_SQL=1` → stderr in `platform/server.ts`). */
function traceSink(trace: Trace): EventSinkService {
  return {
    emit: (event) =>
      Effect.sync(() => {
        if (event.kind === "sql") {
          trace(event.engine, { text: event.sqlText, values: (event.bindValues ?? []) as SQL["values"] });
        }
      }),
  };
}

/** Effect's clock with `currentTimeMillis` replaced; durations still use the real monotonic clock. */
function clockFrom(millis: () => number): EffectClock.Clock {
  const base = EffectClock.make();
  return {
    [EffectClock.ClockTypeId]: EffectClock.ClockTypeId,
    unsafeCurrentTimeMillis: millis,
    unsafeCurrentTimeNanos: () => base.unsafeCurrentTimeNanos(),
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanos: base.currentTimeNanos,
    sleep: (duration) => base.sleep(duration),
  };
}

/**
 * Renders a structured compile failure into the pre-port message, verbatim. Moved here from
 * `platform/compiler.ts` when item 26 deleted that module; `legacyError` below is the only
 * caller. The switch is total over `CompileFailure`: adding a reason without a case here is a
 * compile error.
 */
export function formatCompileError(error: CompileError): Error {
  const message = ((): string => {
    switch (error.reason) {
      case "unknown-collection":
        return `Unknown collection: ${error.table}`;
      case "unknown-field":
        return `Unknown field: ${error.field}`;
      case "array-predicate":
        return `Array predicates/ordering are not supported: ${error.field}`;
      case "unsupported-operator":
        return "Unsupported operator";
      case "gt-requires-numeric":
        return "gt requires a non-null numeric field and value";
      case "invalid-limit":
        return "Invalid limit";
      case "invalid-ordering":
        return "Invalid ordering";
      case "empty-enum":
        return `Enum has no values: ${error.field}`;
      default:
        return EffectFunction.absurd<string>(error.reason);
    }
  })();
  return new Error(message, { cause: error });
}

/**
 * Renders a decode failure. Moved here from `platform/compiler.ts` when item 26 deleted that
 * module; `legacyError` below is the only caller. `unsafe-integer` keeps the pre-port wording;
 * the other two reasons are new — the old code let `JSON.parse`'s own `SyntaxError` escape, and
 * a column missing from the row now surfaces as `missing-column` instead of failing downstream.
 */
export function formatDecodeError(error: DecodeError): Error {
  const message = ((): string => {
    switch (error.reason) {
      case "unsafe-integer":
        return "Integer result exceeds JavaScript safe range";
      case "malformed-json":
        return `Malformed JSON in stored value${error.field ? `: ${error.field}` : ""}`;
      case "missing-column":
        return `Missing column${error.field ? `: ${error.field}` : ""}`;
      default:
        return EffectFunction.absurd<string>(error.reason);
    }
  })();
  return new Error(message, { cause: error });
}

/** Renders a typed failure back into the `Error` the pre-port class threw, message for message. */
function legacyError(failure: unknown): Error {
  if (failure instanceof SchemaError) return formatSchemaError(failure);
  if (failure instanceof CompileError) return formatCompileError(failure);
  if (failure instanceof DecodeError) return formatDecodeError(failure);
  if (failure instanceof SchemaDriftError) {
    return new Error(failure.detail ?? DRIFT_DETAIL, { cause: failure });
  }
  if (failure instanceof QueueFullError) return new Error("Writer queue full", { cause: failure });
  if (failure instanceof ContextExpiredError) {
    return new Error("Transaction context has expired", { cause: failure });
  }
  if (failure instanceof StorageError || failure instanceof NonSerializableResultError) {
    return new Error(failure.detail ?? failure._tag, { cause: failure });
  }
  if (failure instanceof Error) {
    return failure.message ? failure : new Error(failure.name, { cause: failure });
  }
  return new Error(String(failure));
}

/**
 * The compatibility wrapper's one bridge to async callers: settles `effect` on the default runtime
 * via `Effect.runCallback`, rejecting with `legacyError`. Only the `async` methods below await it.
 */
function settle<A, E>(effect: Effect.Effect<A, E>) {
  return {
    // Deliberately awaitable; see the section header above.
    then(onSettled: (value: A) => void, onRejected: (reason: unknown) => void): void {
      Effect.runCallback(effect, {
        onExit: (exit) =>
          Exit.isSuccess(exit) ? onSettled(exit.value) : onRejected(legacyError(Cause.squash(exit.cause))),
      });
    },
  };
}

/**
 * The pre-port API over `makeStorage`: a constructor that throws (and closes the handle) on drift,
 * and `async` methods. `trace`, `clock` and `newId` become an `EventSink`, a `Clock` and an `IdGen`.
 */
export class SQLiteWriter<S extends Schema> {
  private readonly scope: Scope.CloseableScope;
  private readonly storage: StorageService;
  constructor(
    file: string,
    readonly schema: S,
    trace: Trace = () => {},
    clock: () => number = () => Date.now(),
    newId: () => string = () => crypto.randomUUID(),
  ) {
    const scope = Effect.runSync(Scope.make());
    const exit = Effect.runSyncExit(
      makeStorage({ file, schema }).pipe(
        Scope.extend(scope),
        Effect.provideService(EventSink, traceSink(trace)),
        Effect.provideService(IdGen, { next: Effect.sync(newId) }),
        Effect.provideService(Config, LEGACY_CONFIG),
        Effect.withClock(clockFrom(clock)),
      ),
    );
    if (Exit.isFailure(exit)) {
      Effect.runSync(Scope.close(scope, exit));
      throw legacyError(Cause.squash(exit.cause));
    }
    this.scope = scope;
    this.storage = exit.value;
  }
  async mutation(definition: AnyDefinition, args: unknown) {
    return await settle(this.storage.mutation(definition, args));
  }
  async snapshot(destination: string) {
    await settle(this.storage.snapshot(destination));
  }
  async close() {
    await settle(Scope.close(this.scope, Exit.void));
  }
}
