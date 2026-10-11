/**
 * The parent side of the reader IPC (plan item 17): `ReaderClientLive`, a scoped child process
 * speaking the JSON-lines protocol frozen in `platform/services.ts` (`ReaderRequestFrame` out,
 * `ReaderReply` in).
 *
 * Resource shape, in acquisition order (finalizers run in reverse):
 *
 * 1. The child process, under `Effect.acquireRelease`. Release closes stdin, waits up to
 *    `shutdownTimeout` for a graceful exit, then sends SIGTERM, waits again, then SIGKILL; it
 *    always awaits `child.status`, so closing the scope never leaves a stray process.
 * 2. One `forkScoped` writer fiber draining a `Queue` of request frames into stdin — the only
 *    writer, which is what keeps lines whole without a promise chain.
 * 3. One `forkScoped` receiver fiber decoding stdout with the pure `core/ipc/framing.ts` decoder
 *    and completing the caller's `Deferred`.
 *
 * Correlation state is one `Ref` holding either the open connection (a `HashMap` from id to
 * `Deferred`) or the terminal error. Admission (cap check + insert) and connection failure
 * (drain + close) are single `Ref.modify`s, so a call can never register after the drain and hang.
 *
 * Failure semantics (ADR 0002, the `platform/ipc.ts` rows):
 * - Child exit (stdout EOF, then exit): every outstanding call fails with
 *   `ReaderExitedError({ code, signal })`, as does every later call, immediately.
 * - A malformed line, an oversize or truncated frame, a stdout read failure or a stdin write failure
 *   while the child is still running: the connection fails with the matching `IpcError` reason, the
 *   child is killed (it is out of sync with us), and the failure is logged as a `lifecycle` event.
 *   A defect in the receiver or writer fiber does the same, as `stream-failure`.
 * - A reply for an id nobody is waiting on (typically one that already timed out) is logged as an
 *   anomaly event and dropped; the connection stays up.
 * - The 1000-call cap is `QueueFullError({ queue: "reader" })`; each call has a timeout
 *   (`IpcError({ reason: "timeout" })`); a timed-out or interrupted call removes its pending entry.
 *
 * The per-call timeout is a layer option; the composition root (`platform/layers.ts`) passes in
 * `Config.reader.callTimeoutMs` (`READER_CALL_TIMEOUT_MS`).
 *
 * `lines()` is a compatibility surface for code not yet ported: `platform/reader.ts` (item 16) and
 * `tests/unit/framing_test.ts` use it.
 */
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Either,
  Fiber,
  HashMap,
  Layer,
  Option,
  Queue,
  Ref,
  type Scope,
} from "effect";
import { decoder } from "../core/ipc/framing.ts";
import {
  AnalysisError,
  CompileError,
  ContextExpiredError,
  DecodeError,
  HandlerKindMismatch,
  IngestError,
  IpcError,
  NotFoundError,
  QueryWriteAttemptError,
  QueueFullError,
  ReaderError,
  ReaderExitedError,
  type RemoteReaderError,
  RuleError,
  SchemaError,
  UnknownAnalysisQuery,
  UnknownAppError,
  UnknownHandlerError,
} from "../core/errors.ts";
import {
  type EventEnvelope,
  type EventRecord,
  fromPlatformError,
  type Level,
  lifecycleEvent,
  queueEvent,
  type Role,
} from "../core/events.ts";
import {
  EventSink,
  type EventSinkService,
  ReaderClient,
  type ReaderClientService,
  type ReaderReply,
  type ReaderRequest,
  type ReaderRequestFrame,
} from "./services.ts";

export type { ReaderRequest };

/**
 * Small JSON-lines transport. Only trusted named handler requests cross it.
 * Decoding from bytes happens here, at the stream boundary; the buffering and framing rules live
 * in the pure `decoder` (`core/ipc/framing.ts`).
 */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decode = decoder();
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    const result = decode.push(chunk);
    if (Either.isLeft(result)) throw result.left;
    yield* result.right;
  }
  const result = decode.finish();
  if (Either.isLeft(result)) throw result.left;
}

// ===========================================================================
// ReaderClient
// ===========================================================================

/** Everything `call` can fail with. Identical to `ReaderClientService["call"]`'s channel. */
export type CallError = IpcError | ReaderExitedError | QueueFullError | RemoteReaderError;

/** What ends a connection. Every outstanding and later call fails with it. */
export type ConnectionError = IpcError | ReaderExitedError;

export interface ReaderClientOptions {
  /** The reader entry module, run as `deno run -A <module> ...args`. */
  readonly module: string;
  /** Extra arguments after the module. Tests use them to pick a stub's behaviour. */
  readonly args?: readonly string[];
  /** Per-call deadline, measured from admission to reply. Default 30 s. */
  readonly callTimeout?: Duration.DurationInput;
  /** In-flight call cap. Default 1000, today's observable limit. */
  readonly cap?: number;
  /** Grace period for each shutdown step (stdin close → exit → SIGTERM → SIGKILL). Default 5 s. */
  readonly shutdownTimeout?: Duration.DurationInput;
  /**
   * Depths that emit a `high-water` queue event the first time they are reached on this
   * connection. Default: 10/25/50/75/90/100 % of `cap`.
   */
  readonly highWaterMarks?: readonly number[];
  /** The `role` stamped on emitted events. Default `"server"`. */
  readonly role?: Role;
}

/** The service plus what tests need to observe: the child process and the pending-entry count. */
export interface ReaderConnection extends ReaderClientService {
  readonly child: Deno.ChildProcess;
  /** Entries currently awaiting a reply; `0` once nothing is in flight (no leaked `Deferred`). */
  readonly pendingCount: Effect.Effect<number>;
}

export const DEFAULT_CALL_TIMEOUT: Duration.DurationInput = "30 seconds";
export const DEFAULT_READER_CAP = 1000;

type Pending = Deferred.Deferred<unknown, CallError>;

type State =
  | {
    readonly _tag: "open";
    readonly pending: HashMap.HashMap<number, Pending>;
    readonly nextId: number;
    /** Index into the sorted high-water marks of the next mark not yet reached. */
    readonly nextMark: number;
  }
  | { readonly _tag: "closed"; readonly error: ConnectionError };

type Admission =
  | { readonly _tag: "admitted"; readonly id: number; readonly depth: number; readonly marked: boolean }
  | { readonly _tag: "rejected"; readonly error: ConnectionError | QueueFullError };

interface Resources {
  readonly child: Deno.ChildProcess;
  readonly stdin: WritableStreamDefaultWriter<Uint8Array>;
  readonly stdout: ReadableStreamDefaultReader<string>;
}

interface Frame {
  readonly id: number;
  readonly bytes: Uint8Array;
}

/**
 * Spawn the reader and return a connection bound to the current `Scope`. `ReaderClientLive` is this
 * wrapped in `Layer.scoped`; tests call it directly to reach `child` and `pendingCount`.
 */
export function makeReaderConnection(
  options: ReaderClientOptions,
): Effect.Effect<ReaderConnection, never, Scope.Scope | EventSink> {
  return Effect.gen(function* () {
    const sink = yield* EventSink;
    const cap = options.cap ?? DEFAULT_READER_CAP;
    const callTimeout = Duration.decode(options.callTimeout ?? DEFAULT_CALL_TIMEOUT);
    const grace = Duration.decode(options.shutdownTimeout ?? "5 seconds");
    const marks = [...(options.highWaterMarks ?? defaultMarks(cap))].sort((a, b) => a - b);
    const events = eventEmitter(sink, options.role ?? "server", `reader-client-${crypto.randomUUID()}`);

    const state = yield* Ref.make<State>({ _tag: "open", pending: HashMap.empty(), nextId: 1, nextMark: 0 });
    // Bounded so a wedged child cannot grow memory without limit; `call` never blocks on it past
    // its own completion (see `call`). Never shut down: after the connection fails, the writer
    // skips every frame because no id is pending any more.
    const outbox = yield* Queue.bounded<Frame>(cap);

    /**
     * `Some(status)` if `child` exits within `grace`, else `None`. The wait is explicitly
     * interruptible: finalizers run uninterruptibly, and a timeout cannot cut short an
     * uninterruptible effect — it would wait for the exit it was meant to bound.
     */
    const awaitExit = (child: Deno.ChildProcess): Effect.Effect<Option.Option<Deno.CommandStatus>> =>
      Effect.interruptible(Effect.promise(() => child.status)).pipe(
        Effect.timeoutTo({ duration: grace, onSuccess: Option.some, onTimeout: Option.none }),
      );

    const kill = (child: Deno.ChildProcess, signal: Deno.Signal): Effect.Effect<void> =>
      Effect.sync(() => {
        try {
          child.kill(signal);
        } catch { /* already exited */ }
      });

    /**
     * Close the connection with `error`: first caller wins. Fails every outstanding `Deferred`,
     * logs, and kills the child when the failure is ours rather than its exit. `expected` marks the
     * scope's own shutdown, which is logged at `info`.
     */
    const failConnection = (
      child: Deno.ChildProcess,
      error: ConnectionError,
      expected = false,
    ): Effect.Effect<void> =>
      Effect.uninterruptible(Effect.gen(function* () {
        const drained = yield* Ref.modify(state, (s): [Option.Option<Iterable<Pending>>, State] =>
          s._tag === "closed"
            ? [Option.none(), s]
            : [Option.some(HashMap.values(s.pending)), { _tag: "closed", error }]);
        if (Option.isNone(drained)) {
          return;
        }
        for (const deferred of drained.value) {
          yield* Deferred.fail(deferred, error);
        }
        const level: Level = expected ? "info" : error._tag === "IpcError" ? "error" : "warn";
        yield* events.emit(level, (env) =>
          lifecycleEvent({
            ...env,
            phase: error._tag === "IpcError" ? "reader-connection-failed" : "reader-exited",
            detail: fromPlatformError(error),
          }));
        if (error._tag === "IpcError") {
          yield* kill(child, "SIGTERM");
        }
      }));

    const shutdown = (resources: Resources): Effect.Effect<void> =>
      Effect.gen(function* () {
        // EOF on stdin is the reader's signal to finish and exit. `close` waits for an in-flight
        // write, which a wedged child may never drain, so it is bounded and its rejection swallowed.
        const closing = resources.stdin.close().catch(() => {});
        yield* Effect.interruptible(Effect.promise(() => closing)).pipe(
          Effect.timeoutTo({ duration: grace, onSuccess: () => {}, onTimeout: () => {} }),
        );
        let status = yield* awaitExit(resources.child);
        if (Option.isNone(status)) {
          yield* kill(resources.child, "SIGTERM");
          status = yield* awaitExit(resources.child);
        }
        if (Option.isNone(status)) yield* kill(resources.child, "SIGKILL");
        // SIGKILL cannot be ignored, so this wait is bounded in practice.
        const final = Option.isSome(status)
          ? status.value
          : yield* Effect.promise(() => resources.child.status);
        yield* failConnection(resources.child, exitedError(final), true);
        yield* Effect.promise(() => resources.stdout.cancel().catch(() => {}));
      });

    const { child, stdin, stdout } = yield* Effect.acquireRelease(
      Effect.sync((): Resources => {
        const child = new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", options.module, ...(options.args ?? [])],
          stdin: "piped",
          stdout: "piped",
          stderr: "inherit",
        }).spawn();
        return {
          child,
          stdin: child.stdin.getWriter(),
          stdout: child.stdout.pipeThrough(new TextDecoderStream()).getReader(),
        };
      }),
      shutdown,
    );
    yield* events.emit(
      "info",
      (env) => lifecycleEvent({ ...env, phase: "reader-spawned", detail: { pid: child.pid } }),
    );

    /**
     * The error that ends the connection once the transport broke with `cause`. A protocol
     * violation is final at once; an EOF or I/O failure usually means the child died, so its exit
     * (if it follows within `grace`) is the more useful report.
     */
    const terminalError = (cause: IpcError): Effect.Effect<ConnectionError> =>
      cause.reason === "malformed-frame" || cause.reason === "message-too-large"
        ? Effect.succeed(cause)
        : Effect.map(awaitExit(child), Option.match({ onNone: () => cause, onSome: exitedError }));

    /**
     * How the receiver and writer fibers end: a typed failure goes through `terminalError`; a defect
     * fails the connection at once as `stream-failure` (the child is still running, so there is no
     * exit to wait for), so no call is left waiting for a fiber that has died. Interruption is the
     * scope closing, which `shutdown` handles.
     */
    const onTransportFailure = (fiber: "receiver" | "writer") => (cause: Cause.Cause<IpcError>) => {
      if (Cause.isInterruptedOnly(cause)) return Effect.failCause(cause);
      const failure = Cause.failureOption(cause);
      if (Option.isSome(failure)) {
        return Effect.flatMap(terminalError(failure.value), (e) => failConnection(child, e));
      }
      return failConnection(
        child,
        new IpcError({
          reason: "stream-failure",
          detail: `reader ${fiber} fiber died`,
          cause: Cause.squash(cause),
        }),
      );
    };

    /** Remove `id` from the pending map; returns the `Deferred` if it was still there. */
    const take = (id: number) =>
      Ref.modify(state, (s): [Option.Option<Pending>, State] => {
        if (s._tag === "closed") return [Option.none(), s];
        const found = HashMap.get(s.pending, id);
        return Option.isNone(found) ? [found, s] : [found, { ...s, pending: HashMap.remove(s.pending, id) }];
      });

    const isPending = (id: number) =>
      Effect.map(Ref.get(state), (s) => s._tag === "open" && HashMap.has(s.pending, id));

    const settle = (reply: ReaderReply) =>
      Effect.gen(function* () {
        const found = yield* take(reply.id);
        if (Option.isNone(found)) {
          const anomaly = new IpcError({
            reason: "unknown-reply-id",
            detail: `no pending call with id ${reply.id}`,
          });
          yield* events.emit("warn", (env) =>
            lifecycleEvent({ ...env, phase: "reader-reply-anomaly", detail: fromPlatformError(anomaly) }));
          return;
        }
        if ("error" in reply && reply.error !== undefined) {
          yield* Deferred.fail(found.value, rehydrate(reply.error));
        } else yield* Deferred.succeed(found.value, "result" in reply ? reply.result : undefined);
      });

    const receiver = Effect.gen(function* () {
      const decode = decoder();
      while (true) {
        const chunk = yield* Effect.tryPromise({
          try: () => stdout.read(),
          catch: (cause) =>
            new IpcError({ reason: "stream-failure", detail: "reading reader stdout", cause }),
        });
        if (chunk.done) break;
        const decoded = decode.push(chunk.value);
        if (Either.isLeft(decoded)) return yield* decoded.left;
        for (const line of decoded.right) yield* settle(yield* parseReply(line));
        // The decoder latches an oversize remainder and reports it on the next push, which may
        // never come if the child goes quiet; an empty push surfaces it now.
        const latched = decode.push("");
        if (Either.isLeft(latched)) return yield* latched.left;
      }
      const finished = decode.finish();
      if (Either.isLeft(finished)) return yield* finished.left;
      return yield* new IpcError({ reason: "stream-failure", detail: "reader closed stdout" });
    }).pipe(Effect.catchAllCause(onTransportFailure("receiver")));

    const writer = Effect.gen(function* () {
      while (true) {
        const frame = yield* Queue.take(outbox);
        // A call that timed out, was interrupted or was failed with the connection is not sent.
        if (!(yield* isPending(frame.id))) continue;
        yield* Effect.tryPromise({
          try: () => stdin.write(frame.bytes),
          catch: (cause) => new IpcError({ reason: "write-failed", detail: "writing reader stdin", cause }),
        });
      }
    }).pipe(
      // A write fails mostly because the child died; `terminalError` prefers that exit if it follows.
      Effect.catchAllCause(onTransportFailure("writer")),
    );

    yield* Effect.forkScoped(receiver);
    yield* Effect.forkScoped(writer);

    const call = (request: ReaderRequest): Effect.Effect<unknown, CallError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<unknown, CallError>();
          const admission = yield* Ref.modify(state, (s): [Admission, State] => {
            if (s._tag === "closed") return [{ _tag: "rejected", error: s.error }, s];
            const depth = HashMap.size(s.pending);
            if (depth >= cap) {
              return [{ _tag: "rejected", error: new QueueFullError({ queue: "reader", depth, cap }) }, s];
            }
            const id = s.nextId;
            let nextMark = s.nextMark;
            while (nextMark < marks.length && depth + 1 >= marks[nextMark]) nextMark++;
            return [
              { _tag: "admitted", id, depth: depth + 1, marked: nextMark !== s.nextMark },
              { _tag: "open", pending: HashMap.set(s.pending, id, deferred), nextId: id + 1, nextMark },
            ];
          });
          if (admission._tag === "rejected") {
            const error = admission.error;
            if (error._tag === "QueueFullError") {
              yield* events.emit("warn", (env) =>
                queueEvent({
                  ...env,
                  queue: "reader",
                  depth: error.depth,
                  cap,
                  event: "rejected",
                  dropped: 0,
                }));
            }
            return yield* error;
          }
          const { id, depth } = admission;
          if (admission.marked) {
            yield* events.emit("info", (env) =>
              queueEvent({ ...env, queue: "reader", depth, cap, event: "high-water", dropped: 0 }));
          }
          const encoded = encodeFrame({ ...request, id });
          if (Either.isLeft(encoded)) {
            yield* take(id);
            return yield* encoded.left;
          }
          // `raceFirst` so a caller blocked on a full outbox still observes its Deferred failing
          // (connection death); once offered, only the Deferred can end the race.
          const awaitReply = Effect.raceFirst(
            Effect.zipRight(Queue.offer(outbox, { id, bytes: encoded.right }), Effect.never),
            Deferred.await(deferred),
          ).pipe(
            Effect.timeoutFail({
              duration: callTimeout,
              onTimeout: () =>
                new IpcError({
                  reason: "timeout",
                  detail: `no reply to ${request.kind} after ${Duration.format(callTimeout)}`,
                }),
            }),
          );
          // The wait runs on its own interruptible daemon fiber. A timeout awaits the loser it
          // interrupts, so if the wait inherited an uninterruptible caller's flags (a finalizer,
          // say) the timeout would block forever on a Deferred nobody completes. As a daemon it
          // also does not receive the caller's interrupt signals, so an uninterruptible caller
          // still sees the call through; an interruptible one interrupts it via `ensuring`.
          const reply = yield* Effect.forkDaemon(Effect.interruptible(awaitReply));
          return yield* restore(Fiber.join(reply)).pipe(
            // Timeout, interruption and success all leave the map without this id and no fiber.
            Effect.ensuring(Effect.zipRight(take(id), Fiber.interrupt(reply))),
          );
        })
      );

    const pendingCount = Effect.map(Ref.get(state), (s) => (s._tag === "open" ? HashMap.size(s.pending) : 0));

    return { call, child, pendingCount } satisfies ReaderConnection;
  });
}

/** `ReaderClient` backed by a scoped child process running `options.module`. */
export function ReaderClientLive(options: ReaderClientOptions): Layer.Layer<ReaderClient, never, EventSink> {
  return Layer.scoped(ReaderClient, Effect.map(makeReaderConnection(options), ({ call }) => ({ call })));
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function defaultMarks(cap: number): number[] {
  return [...new Set([0.1, 0.25, 0.5, 0.75, 0.9, 1].map((f) => Math.max(1, Math.ceil(f * cap))))];
}

function exitedError(status: Deno.CommandStatus): ReaderExitedError {
  return new ReaderExitedError(
    status.signal ? { code: status.code, signal: status.signal } : { code: status.code },
  );
}

const utf8 = new TextEncoder();

function encodeFrame(frame: ReaderRequestFrame): Either.Either<Uint8Array, IpcError> {
  try {
    return Either.right(utf8.encode(JSON.stringify(frame) + "\n"));
  } catch (cause) {
    return Either.left(
      new IpcError({ reason: "write-failed", detail: "request is not JSON-serializable", cause }),
    );
  }
}

/** A line becomes a `ReaderReply` or fails the connection with `malformed-frame`. */
function parseReply(line: string): Effect.Effect<ReaderReply, IpcError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    return Effect.fail(new IpcError({ reason: "malformed-frame", detail: excerpt(line), cause }));
  }
  if (
    parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
    !Number.isSafeInteger((parsed as { id?: unknown }).id)
  ) {
    return Effect.fail(new IpcError({ reason: "malformed-frame", detail: excerpt(line) }));
  }
  // `result` may legitimately be absent: `JSON.stringify` drops an `undefined` handler result.
  return Effect.succeed(parsed as ReaderReply);
}

function excerpt(line: string): string {
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

type RemoteTag = RemoteReaderError["_tag"];

const REMOTE_ERRORS: {
  readonly [K in RemoteTag]: new (fields: never) => Extract<RemoteReaderError, { _tag: K }>;
} = {
  SchemaError,
  CompileError,
  DecodeError,
  RuleError,
  NotFoundError,
  ContextExpiredError,
  QueryWriteAttemptError,
  ReaderError,
  QueueFullError,
  UnknownAppError,
  UnknownHandlerError,
  HandlerKindMismatch,
  IngestError,
  AnalysisError,
  UnknownAnalysisQuery,
};

/**
 * Turn an error frame back into the class the reader raised, so its HTTP status comes from
 * `toHttpStatus`. The frame's `message` is kept as the error's non-enumerable `message` (as on a
 * native `Error`), so it renders but stays out of `fromPlatformError`'s structured detail.
 *
 * A bare string is the pre-item-16 reader's `{ id, error: e.message }`; it becomes a `ReaderError`
 * carrying that text until the reader sends frames. An unrecognised frame fails only its own call.
 */
function rehydrate(frame: unknown): RemoteReaderError | IpcError {
  if (typeof frame === "string") {
    return withMessage(new ReaderError({ operation: "select", detail: frame }), frame);
  }
  if (frame === null || typeof frame !== "object") {
    return new IpcError({ reason: "malformed-frame", detail: "error frame is not an object" });
  }
  const { _tag, message, fields } = frame as { _tag?: unknown; message?: unknown; fields?: unknown };
  if (typeof _tag !== "string" || !Object.hasOwn(REMOTE_ERRORS, _tag)) {
    return new IpcError({ reason: "malformed-frame", detail: `unknown error tag ${String(_tag)}` });
  }
  const Ctor = REMOTE_ERRORS[_tag as RemoteTag];
  // The reader is trusted to send the fields its own class declared.
  const error = new Ctor((fields !== null && typeof fields === "object" ? fields : {}) as never);
  return typeof message === "string" ? withMessage(error, message) : error;
}

function withMessage<E extends Error>(error: E, message: string): E {
  Object.defineProperty(error, "message", {
    value: message,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return error;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function eventEmitter(sink: EventSinkService, role: Role, traceId: string) {
  return {
    emit: (level: Level, build: (envelope: EventEnvelope) => EventRecord) =>
      Effect.flatMap(Clock.currentTimeMillis, (ms) =>
        sink.emit(build({
          eventId: crypto.randomUUID(),
          ts: new Date(ms).toISOString(),
          level,
          role,
          pid: Deno.pid,
          traceId,
        }))),
  };
}
