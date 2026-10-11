/**
 * The server (writer) process entrypoint (plan item 22, works 5, 6 and 8): `PlatformLive`, one HTTP
 * listener over `platform/http/router.ts`, the backup timer, and shutdown.
 *
 * Everything runs in one root fiber over one `Scope`. Resources are acquired in the order below, so
 * closing the scope releases them in exactly the reverse order:
 *
 * ```text
 * main          signal listeners
 * PlatformLive  Config → logging → shutdown marker → IdGen → ObjectStore, AppRegistry
 *               → per-app Storage + Backups → ReaderClient (child process)      (platform/layers.ts)
 * program       backup fiber → HTTP listener
 *
 * shutdown:     HTTP drain → backup fiber → reader child → DB handles
 *               → `lifecycle` shutdown event → log drain + close → signal listeners
 * ```
 *
 * - **HTTP drain first.** `server.shutdown()` stops accepting and waits for in-flight requests, so a
 *   mutation that was admitted completes (or rolls back on its own failure) against a still-open
 *   database before anything below it closes. The storage finalizer additionally waits for its
 *   writer queue to drain. The reader child runs in its own process group (`platform/ipc.ts`), so a
 *   group signal (Ctrl-C, a systemd stop) reaches only this process and cannot stop the reader
 *   ahead of the drain.
 * - **Signals interrupt the root fiber.** SIGINT/SIGTERM complete a `Deferred`. Once serving, the
 *   program emits a `lifecycle` `stopping` event naming the signal and then interrupts itself, which
 *   closes the scope. The listeners are installed before `PlatformLive` builds, and a signal while it
 *   builds or while the startup ping waits interrupts startup at once (releasing whatever was
 *   acquired, log included). They are removed last, so a second signal during shutdown cannot kill
 *   the process half-way.
 * - **The log flushes last.** The `lifecycle` `shutdown` event is emitted by a finalizer that sits
 *   directly above the logging layer, so it is the final line of the server's log file.
 *
 * Only a failure to *start* (bad configuration, schema drift, a reader that will not answer) reaches
 * stderr, because the event log may not exist yet; the process then exits 1.
 */
import { Cause, Deferred, Duration, Effect, Exit, Layer, Option, Runtime, Schedule } from "effect";
import type { AnyError } from "../core/errors.ts";
import { fromPlatformError } from "../core/events.ts";
import { devTokensInUse } from "./http/auth.ts";
import { handle, type RouterRequirements } from "./http/router.ts";
import { emitServerLifecycle, PlatformLive } from "./layers.ts";
import { AppServices } from "./registry.ts";
import { Config, EventSink, ReaderClient } from "./services.ts";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Installs the signal listeners for the life of the scope; `received` completes on the first signal. */
const signalHandlers = Effect.acquireRelease(
  Effect.gen(function* () {
    const received = yield* Deferred.make<Deno.Signal>();
    const listeners = SIGNALS.map((signal) =>
      [signal, () => void Deferred.unsafeDone(received, Effect.succeed(signal))] as const
    );
    for (const [signal, listener] of listeners) Deno.addSignalListener(signal, listener);
    return { received, listeners };
  }),
  ({ listeners }) =>
    Effect.sync(() => {
      for (const [signal, listener] of listeners) Deno.removeSignalListener(signal, listener);
    }),
);

/**
 * The backup timer: when `BACKUP_INTERVAL_MS` is non-zero, one scoped fiber sweeps every app's
 * backup in turn, then waits the interval before the next sweep (`Schedule.spaced`, first sweep one
 * interval after start, as the pre-port `setInterval`). A sweep is a plain sequential effect, so two
 * can never overlap — no guard flag needed. Each `take` records its own `backup` events (with the
 * failing phase on a failure), so a failed app is logged and the sweep moves on.
 */
const backupTimer = Effect.gen(function* () {
  const { intervalMs } = (yield* Config).backup;
  if (intervalMs === 0) return;
  const stacks = (yield* AppServices).all;
  const sweep = Effect.forEach(
    stacks,
    (stack) =>
      stack.backups.take(stack.app.id).pipe(
        Effect.asVoid,
        Effect.catchAll(() => Effect.void),
        Effect.catchAllCause((cause) => Effect.logError("backup sweep defect", cause)),
      ),
    { discard: true },
  );
  yield* Effect.forkScoped(Effect.schedule(sweep, Schedule.spaced(Duration.millis(intervalMs))));
});

/**
 * `Deno.serve` under `Effect.acquireRelease`. Each request runs `handle` on this fiber's runtime, so
 * it sees every service in `PlatformLive`. Release is `server.shutdown()`: stop accepting, then wait
 * for every in-flight request to finish.
 */
const listen = Effect.gen(function* () {
  const { server: settings } = yield* Config;
  const sink = yield* EventSink;
  const run = Runtime.runPromise(yield* Effect.runtime<RouterRequirements>());
  const internalError = () =>
    Response.json({ error: { tag: "Defect", message: "internal error" } }, { status: 500 });
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Deno.serve({
        hostname: settings.hostname,
        port: settings.port,
        // Both defaults write to the console; startup is reported as a `lifecycle` event instead.
        onListen: () => {},
        onError: internalError,
      }, (request) => run(handle(request)).catch(internalError))
    ),
    (server) =>
      Effect.zipRight(
        Effect.promise(() => server.shutdown()),
        emitServerLifecycle(sink, "http-drained"),
      ),
  );
  return server;
});

const program = (signal: Deferred.Deferred<Deno.Signal>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const config = yield* Config;

    const devTokens = devTokensInUse(config);
    if (devTokens.length > 0) {
      yield* emitServerLifecycle(sink, "config", {
        message: "default dev-only token in use",
        tokens: devTokens,
        note: "Local/trusted-app MVP: set these before exposing this server.",
      }, "warn");
    }

    // The reader must answer before the server takes traffic, as before the port. A signal while it
    // has not yet answered stops startup instead of waiting out the call timeout.
    yield* Effect.raceFirst(
      (yield* ReaderClient).call({ kind: "ping" }),
      Effect.flatMap(Deferred.await(signal), (reason) =>
        Effect.zipRight(emitServerLifecycle(sink, "stopping", { reason }), Effect.interrupt)),
    );
    yield* backupTimer;
    const server = yield* listen;
    yield* emitServerLifecycle(sink, "ready", {
      hostname: server.addr.hostname,
      port: server.addr.port,
      apps: (yield* AppServices).all.map((stack) =>
        stack.app.id
      ),
      backupIntervalMs: config.backup.intervalMs,
    });

    const reason = yield* Effect.raceFirst(
      Deferred.await(signal),
      Effect.as(Effect.promise(() => server.finished), "listener-closed"),
    );
    yield* emitServerLifecycle(sink, "stopping", { reason });
    return yield* Effect.interrupt;
  });

/**
 * The root: signal listeners first, then `PlatformLive` and the program, all in one scope. A signal
 * during the layer build interrupts it; the build's finalizers are already in the scope, so what was
 * acquired is released in order and the log drains.
 */
const main = Effect.scoped(Effect.gen(function* () {
  const { received } = yield* signalHandlers;
  const context = yield* Effect.raceFirst(
    Layer.build(PlatformLive),
    Effect.zipRight(Deferred.await(received), Effect.interrupt),
  );
  return yield* Effect.provide(program(received), context);
}));

/** A startup failure as one line: the tag and its payload, or the rendered cause. */
function describeFailure(cause: Cause.Cause<unknown>): string {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure !== undefined && failure !== null && typeof failure === "object" && "_tag" in failure) {
    const { errorTag, errorDetail } = fromPlatformError(failure as AnyError);
    try {
      return `${errorTag} ${JSON.stringify(errorDetail)}`;
    } catch {
      return errorTag;
    }
  }
  return Cause.pretty(cause);
}

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(main);
  if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
    Deno.stderr.writeSync(new TextEncoder().encode(`ts-db server failed: ${describeFailure(exit.cause)}\n`));
    Deno.exit(1);
  }
  Deno.exit(0);
}
