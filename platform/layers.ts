/**
 * The composition roots (plan item 22, work 7): every live layer, wired once.
 *
 * ## `PlatformLive` — the server (writer) process
 *
 * The plan's sketch is `Layer.mergeAll(ConfigLive, LoggerLive, EventSinkLive, AppRegistryLive,
 * IdGenLive, StorageLive, ReaderClientLive, ObjectStoreLive, BackupsLive)`. Two things change in the
 * real wiring, both on purpose:
 *
 * 1. **`Storage` and `Backups` are per app.** The writer owns one `DatabaseSync` handle per SQLite
 *    file, so there is one `StorageLive` (and one `BackupsLive` bound to it) per registered app.
 *    `AppServicesLive` builds those stacks into its own scope and exposes them behind the
 *    `AppServices` tag (`platform/registry.ts`); the router never sees a bare `Storage`.
 * 2. **The layers are a chain, not a flat merge.** `Layer.mergeAll` may build (and therefore
 *    release) its members concurrently, and shutdown order is load-bearing here. Each
 *    `Layer.provideMerge` below builds its argument first and releases it last, so acquisition and
 *    release are both total orders:
 *
 * ```text
 * acquire:  Config → Logging (sink + Logger) → shutdown marker → IdGen → ObjectStore, AppRegistry
 *           → AppServices (per-app Storage + Backups) → ReaderClient (child process)
 * release:  ReaderClient → AppServices → … → shutdown marker → Logging (drain, close) → Config
 * ```
 *
 * `platform/server.ts` acquires the backup fiber and then the HTTP listener inside this context, so
 * the full shutdown sequence is HTTP drain → backup fiber → reader child → DB handles → final
 * `lifecycle` event → log flush. The "shutdown marker" is a finalizer-only layer that emits the
 * `lifecycle` `shutdown` event after everything that could still log has closed and before the sink
 * drains, so it is the last line of the server's log file.
 *
 * Memoization: within one build, Effect memoizes layers by reference, so `ConfigLive` and the
 * logging layer — required by nearly every other layer — are each built exactly once and shared.
 * `Layer.memoize` (which shares a layer across *separate* builds) has no second build to serve in
 * this process, so it is not used.
 *
 * ## The reader process root
 *
 * The two processes must not share a module graph: this one loads `node:sqlite` (`StorageLive`), the
 * reader loads `@duckdb/node-api`, and one process must never hold both SQLite copies (ADR 0001,
 * `platform/duckdb.ts`). So the reader's root cannot live here as a value — importing
 * `EventLogIngestLive` would load DuckDB into the writer, and `platform/reader.ts` importing this
 * module would load `node:sqlite` into the reader. What is fixed here is its *shape*:
 * `ReaderProcessServices` = `Config` + the reader's `EventSink` (`LoggingReaderLive`) +
 * `EventLogIngest`, with per-app `ReaderLive` instances opened lazily by `makeReaderPool`
 * (`platform/duckdb.ts`) inside the reader's program scope. `platform/reader.ts` composes it.
 *
 * The event-log modules are imported below **as types only**: `deno task check` type-checks
 * `platform/eventlog/*` through this file, and nothing of theirs is loaded at runtime.
 *
 * ## Seams for the multitenancy plan
 *
 * MT-05/MT-07 replace `AppRegistryLive`/`AppServicesLive` (resolve stacks per tenant behind the same
 * `AppServices.get`) and the auth functions in `platform/http/auth.ts`; nothing else in this chain
 * names an app.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Context, Duration, Effect, Exit, Layer } from "effect";
import { StorageError } from "../core/errors.ts";
import { lifecycleEvent } from "../core/events.ts";
import { BackupsLive } from "./backup.ts";
import { ConfigLive } from "./config.ts";
// Type-only, on purpose: see "The reader process root" above.
import type { EventLogIngestLive } from "./eventlog/ingest.ts";
import type { StagedLine } from "./eventlog/tables.ts";
import { ReaderClientLive } from "./ipc.ts";
import { LoggingLive } from "./logging/logger.ts";
import { ObjectStoreLive } from "./object_store.ts";
import { AppRegistryLive, AppServices, type AppStack, makeAppServices } from "./registry.ts";
import { IdGenLive, StorageLive } from "./sqlite.ts";
import {
  AppRegistry,
  Backups,
  Config,
  EventSink,
  type EventSinkService,
  type ReaderClient,
  Storage,
} from "./services.ts";

/** The reader entry module the server spawns as its child process. */
export const READER_MODULE = fileURLToPath(new URL("./reader.ts", import.meta.url));

/** A `lifecycle` event from the server process, outside any request. */
export function emitServerLifecycle(
  sink: EventSinkService,
  phase: string,
  detail?: unknown,
  level: "info" | "warn" | "error" = "info",
): Effect.Effect<void> {
  return Effect.flatMap(
    Effect.clockWith((clock) => clock.currentTimeMillis),
    (ms) =>
      sink.emit(lifecycleEvent({
        eventId: crypto.randomUUID(),
        ts: new Date(ms).toISOString(),
        level,
        role: "server",
        pid: Deno.pid,
        traceId: "server-lifecycle",
        phase,
        ...(detail === undefined ? {} : { detail }),
      })),
  );
}

/**
 * One `StorageLive` + `BackupsLive` per registered app, built into this layer's scope in registry
 * order (and so closed in reverse). Each app's data directory is created first, as before the port.
 */
export const AppServicesLive = Layer.scoped(
  AppServices,
  Effect.gen(function* () {
    const apps = yield* (yield* AppRegistry).all;
    const stacks: AppStack[] = [];
    for (const app of apps) {
      yield* Effect.tryPromise({
        try: () => Deno.mkdir(dirname(app.file), { recursive: true }),
        catch: (cause) =>
          new StorageError({ operation: "open", detail: `cannot create ${dirname(app.file)}`, cause }),
      });
      const stack = BackupsLive.pipe(
        Layer.provideMerge(StorageLive({ file: app.file, schema: app.schema, appId: app.id })),
      );
      const context = yield* Layer.build(stack);
      stacks.push({ app, storage: Context.get(context, Storage), backups: Context.get(context, Backups) });
    }
    return makeAppServices(stacks);
  }),
);

/** `ReaderClientLive` over the reader module, with the per-call deadline from `READER_CALL_TIMEOUT_MS`. */
export const ReaderClientConfigured: Layer.Layer<ReaderClient, never, Config | EventSink> = Layer
  .unwrapEffect(
    Effect.map(Config, (config) =>
      ReaderClientLive({
        module: READER_MODULE,
        callTimeout: Duration.millis(config.reader.callTimeoutMs),
      })),
  );

/**
 * Finalizer only: emits the `lifecycle` `shutdown` event when the platform's scope closes. Placed
 * directly above the logging layer, so it runs after every other finalizer and before the drain.
 */
export const ShutdownEventLive: Layer.Layer<never, never, EventSink> = Layer.scopedDiscard(
  Effect.flatMap(EventSink, (sink) =>
    Effect.addFinalizer((exit) =>
      emitServerLifecycle(sink, "shutdown", {
        exit: Exit.isSuccess(exit)
          ? "success"
          : Cause.isInterruptedOnly(exit.cause)
          ? "interrupted"
          : "failure",
      })
    )),
);

/** Everything the server process serves with. See the module comment for the order. */
export const PlatformLive = ReaderClientConfigured.pipe(
  Layer.provideMerge(AppServicesLive),
  Layer.provideMerge(Layer.mergeAll(ObjectStoreLive, AppRegistryLive)),
  Layer.provideMerge(IdGenLive),
  Layer.provideMerge(ShutdownEventLive),
  Layer.provideMerge(LoggingLive),
  Layer.provideMerge(ConfigLive),
);

/** What `PlatformLive` provides. */
export type PlatformServices = Layer.Layer.Success<typeof PlatformLive>;

/**
 * What the reader process's root provides (`ConfigLive` + `LoggingReaderLive` +
 * `EventLogIngestLive`), besides its lazily opened per-app readers. A type, not a layer: see the
 * module comment.
 */
export type ReaderProcessServices = Config | EventSink | Layer.Layer.Success<typeof EventLogIngestLive>;

/** One staged event-log line, as the reader's ingest sees it. Re-exported for the same coverage. */
export type { StagedLine };
