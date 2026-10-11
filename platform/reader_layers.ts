/**
 * The reader process's composition root (plan item 33). It does for `platform/reader.ts` what
 * `platform/layers.ts` does for the server, and lives apart from it on purpose: the two processes
 * must not share a module graph (ADR 0001). This module reaches `@duckdb/node-api` through
 * `platform/eventlog/ingest.ts`; it must never reach `node:sqlite`, and nothing the server loads may
 * import it (`tests/unit/server_scope_test.ts` and `tests/unit/reader_ingest_test.ts` walk both graphs).
 *
 * ## The chain
 *
 * ```text
 * acquire:  Config → Logging (reader sink + Logger) → IdGen → EventLogIngest (handle opens lazily)
 * release:  EventLogIngest (connection, then instance) → IdGen → Logging (drain) → Config
 * ```
 *
 * Each `Layer.provideMerge` builds its argument first and releases it last, so the event-log handle
 * closes before the log drains and its `eventlog-closed` record still reaches the file. The per-app
 * query readers (`makeReaderPool`) open inside `platform/reader.ts`'s program scope, which closes
 * before this chain's.
 *
 * ## The event-log handle
 *
 * One persistent DuckDB event-log file (`Config.eventLog.duckdbPath`), opened by
 * `makeEventLogIngest` — connection registered after the instance, so released before it. The
 * handle opens on the first `ingest` request rather than at startup, into its own child of this
 * layer's scope, and then stays open for the life of the process:
 *
 * - **Queries never depend on it.** A file that cannot be opened (a bad path, a lock held by another
 *   process, an incompatible schema that `EVENTLOG_DDL`'s guards refuse) fails that `ingest` with a
 *   typed `IngestError`; the reader still starts, answers `ping`, and serves queries.
 * - **A failed open is not cached.** Its child scope is closed (whatever it opened is released) and
 *   the next `ingest` tries again — the same rule `makeReaderPool` applies to app readers.
 * - **Ingest-then-sweep.** `ingest` is item 36's coordinator, `ingestThenSweep()`: an ingest run,
 *   then — only after it committed — torn-tail sealing and the retention sweep over the committed
 *   watermarks, in this process, which is the only one that can read `_ingest_state` (ADR 0007).
 *   The reply is an `IngestThenSweepReport`, a superset of the frozen `IngestReport`.
 *
 * The reader serves one request at a time, so ingest and query never run concurrently; the
 * coordinator's own lock would serialize overlapping ingests from an in-process caller as well.
 *
 * ## The reader's own open log file
 *
 * The coordinator never seals, gzips or deletes a path this process's sink holds open. The sink does
 * not publish its path, but it writes one file at a time, named
 * `reader/<date>/events-<HH>-<pid>-<seq>.jsonl` and always later than every earlier one of this pid,
 * so the newest such file is the open one (`ownOpenLogPaths`). The server's open files are protected
 * by the coordinator's other rails: today's directory is never touched and an unsettled file is not
 * closed.
 */
import { join } from "node:path";
import { Cause, Duration, Effect, ExecutionStrategy, Exit, Layer, Option, Scope } from "effect";
import type { ConfigError, IngestError } from "../core/errors.ts";
import { compareSourceFiles, parseSourceFile, type SourceFile } from "../core/eventlog/offsets.ts";
import { ConfigLive } from "./config.ts";
import { emitLifecycle } from "./duckdb.ts";
import {
  type EventLogDriver,
  type IngestThenSweepReport,
  makeEventLogIngest,
  type RetentionCoordinatorOptions,
} from "./eventlog/ingest.ts";
import { LoggingReaderLive } from "./logging/logger.ts";
import { Config, EventLogIngest, EventSink, IdGen } from "./services.ts";

/**
 * The reader's own `IdGen`. `IdGenLive` lives in `platform/sqlite.ts`, which loads `node:sqlite`
 * and so may never be imported here.
 */
export const ReaderIdGenLive: Layer.Layer<IdGen> = Layer.succeed(IdGen, {
  next: Effect.sync(() => crypto.randomUUID()),
});

/**
 * The newest `reader/*\/events-*-<pid>-*.jsonl` under `logDir`: the file this process's sink holds
 * open (see the module comment). Empty when the sink has not written yet or the tree is unreadable;
 * the coordinator's today/settle rails still cover that file.
 */
export function ownOpenLogPaths(logDir: string, pid: number): Effect.Effect<readonly string[]> {
  return Effect.promise(async () => {
    const mine: SourceFile[] = [];
    try {
      for await (const day of Deno.readDir(join(logDir, "reader"))) {
        if (!day.isDirectory) continue;
        for await (const file of Deno.readDir(join(logDir, "reader", day.name))) {
          const source = file.isFile ? parseSourceFile(`reader/${day.name}/${file.name}`) : undefined;
          if (source !== undefined && source.pid === pid) mine.push(source);
        }
      }
    } catch {
      return [];
    }
    const newest = mine.sort(compareSourceFiles).at(-1);
    return newest === undefined ? [] : [join(logDir, newest.path)];
  });
}

export interface ReaderEventLogOptions {
  /** How the event-log file is opened. Tests wrap the real driver to observe or fail it. */
  readonly driver?: EventLogDriver;
  /** Target new bytes per ingest transaction (`makeEventLogIngest`'s `batchBytes`). */
  readonly batchBytes?: number;
  /** How the coordinator judges a file closed. Default: this process's open log file, default settle. */
  readonly retention?: RetentionCoordinatorOptions;
}

/**
 * The reader's `EventLogIngest`, built in the current scope: `ingest` runs ingest-then-sweep over a
 * persistent handle that opens on first use (see the module comment). Never fails to build.
 */
export function makeReaderEventLog(
  options: ReaderEventLogOptions = {},
): Effect.Effect<
  { readonly ingest: Effect.Effect<IngestThenSweepReport, IngestError> },
  never,
  Scope.Scope | Config | EventSink
> {
  return Effect.gen(function* () {
    const root = yield* Effect.scope;
    const config = yield* Config;
    const sink = yield* EventSink;
    const services = yield* Effect.context<Config | EventSink>();
    const path = config.eventLog.duckdbPath;
    const retention: RetentionCoordinatorOptions = {
      openPaths: ownOpenLogPaths(config.logging.dir, Deno.pid),
      ...options.retention,
    };

    const open = Effect.gen(function* () {
      const scope = yield* Scope.fork(root, ExecutionStrategy.sequential);
      let opened = false;
      // Added first, so it runs last: after the connection and then the instance have closed.
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() => opened ? emitLifecycle(sink, "eventlog-closed", { path }) : Effect.void),
      );
      const exit = yield* Effect.exit(
        Scope.extend(
          makeEventLogIngest({ driver: options.driver, batchBytes: options.batchBytes, retention }),
          scope,
        ).pipe(Effect.provide(services)),
      );
      if (Exit.isFailure(exit)) {
        yield* Scope.close(scope, exit);
        return yield* exit;
      }
      opened = true;
      yield* emitLifecycle(sink, "eventlog-opened", { path });
      return exit.value;
    });

    // Memoizes the open, and is invalidated when it fails, so the next `ingest` retries it.
    const [handle, invalidate] = yield* Effect.cachedInvalidateWithTTL(open, Duration.infinity);

    const ingest = Effect.gen(function* () {
      const control = yield* handle.pipe(
        // Any failed open, a defect included, is dropped from the cache so the next ingest retries.
        Effect.tapErrorCause((cause) =>
          Effect.zipRight(
            invalidate,
            emitLifecycle(sink, "eventlog-open-failed", {
              path,
              ...Option.match(Cause.failureOption(cause), {
                onNone: () => ({ defect: Cause.pretty(cause) }),
                onSome: (error) => ({ phase: error.phase, detail: error.detail }),
              }),
            }, "warn"),
          )
        ),
      );
      return yield* control.ingestThenSweep();
    });
    return { ingest };
  });
}

/** `EventLogIngest` over `makeReaderEventLog`. */
export function readerEventLogLayer(
  options: ReaderEventLogOptions = {},
): Layer.Layer<EventLogIngest, never, Config | EventSink> {
  return Layer.scoped(EventLogIngest, makeReaderEventLog(options));
}

export interface ReaderRootOptions extends ReaderEventLogOptions {
  /** Where `Config` comes from. Default `ConfigLive` (the inherited environment). */
  readonly config?: Layer.Layer<Config, ConfigError>;
}

/** The reader process's root, in the order of the module comment. */
export function makeReaderRootLive(options: ReaderRootOptions = {}) {
  return readerEventLogLayer(options).pipe(
    Layer.provideMerge(ReaderIdGenLive),
    Layer.provideMerge(LoggingReaderLive),
    Layer.provideMerge(options.config ?? ConfigLive),
  );
}

/** The production reader root. */
export const ReaderRootLive = makeReaderRootLive();

/** What the reader root provides: `Config`, the reader's `EventSink`, `IdGen` and `EventLogIngest`. */
export type ReaderRootServices = Layer.Layer.Success<typeof ReaderRootLive>;
