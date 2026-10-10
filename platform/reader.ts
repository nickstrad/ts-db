/**
 * The reader process entrypoint (plan item 16): JSON-lines requests on stdin, JSON-lines replies on
 * stdout, one query at a time.
 *
 * It deliberately never imports Node's built-in SQLite module — see `platform/duckdb.ts`.
 *
 * **stdout is the RPC channel and nothing else.** Every log record goes through `LoggingReaderLive`
 * to `<LOG_DIR>/reader/<date>/…jsonl`; the only other output is a stderr report if the process
 * cannot start or dies.
 *
 * Shape of the program:
 * - a scoped stdin consumer decodes frames with `core/ipc/framing` and serves them strictly in order,
 *   writing each reply before reading the next request (serialized execution, as before the port);
 * - per-app readers come from `makeReaderPool` (`platform/duckdb.ts`), opened lazily into the
 *   program's scope and closed with it; a failed open is not cached, and a reader whose `BEGIN`
 *   failed is dropped, so the next request retries on a fresh connection;
 * - every failure a request can produce is answered as a `ReaderErrorFrame` (`platform/services.ts`),
 *   so the parent can rehydrate the tag. A malformed frame is a protocol violation and ends the
 *   process, as it did before the port;
 * - stdin EOF, SIGINT or SIGTERM closes the scope: readers close connection-then-instance, then the
 *   log sink drains and closes.
 */
import { Cause, Effect, Exit, Layer, Logger, Option } from "effect";
import {
  ConfigError,
  HandlerKindMismatch,
  IngestError,
  IpcError,
  ReaderError,
  type RemoteReaderError,
  UnknownAnalysisQuery,
  UnknownAppError,
  UnknownHandlerError,
} from "../core/errors.ts";
import { decoder } from "../core/ipc/framing.ts";
import { ConfigLive } from "./config.ts";
import { emitLifecycle, makeReaderPool } from "./duckdb.ts";
import { LoggingReaderLive } from "./logging/logger.ts";
import { loadApps } from "./registry.ts";
import { EventSink, type ReaderErrorFrame, type ReaderReply, type ReaderRequestFrame } from "./services.ts";

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** Validates one request line against the frozen `ReaderRequestFrame` shape. */
function parseFrame(line: string): Effect.Effect<ReaderRequestFrame, IpcError> {
  return Effect.gen(function* () {
    const value: unknown = yield* Effect.try({
      try: () => JSON.parse(line),
      catch: (cause) => new IpcError({ reason: "malformed-frame", detail: "request is not JSON", cause }),
    });
    const frame = value as Record<string, unknown> | null;
    const malformed = (detail: string) => Effect.fail(new IpcError({ reason: "malformed-frame", detail }));
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return yield* malformed("request is not an object");
    }
    if (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id)) {
      return yield* malformed("request id is not an integer");
    }
    switch (frame.kind) {
      case "ping":
      case "ingest":
        return frame as ReaderRequestFrame;
      case "query":
        if (typeof frame.appId !== "string" || typeof frame.name !== "string") {
          return yield* malformed("query request needs string appId and name");
        }
        return frame as ReaderRequestFrame;
      case "analysis":
        if (typeof frame.name !== "string" || typeof frame.params !== "object" || frame.params === null) {
          return yield* malformed("analysis request needs a name and params");
        }
        return frame as ReaderRequestFrame;
      default:
        return yield* malformed(`unknown request kind ${JSON.stringify(frame.kind)}`);
    }
  });
}

/** JSON that cannot throw on the values tagged errors carry (`DecodeError.actual` may be a bigint). */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v);
}

/** A one-line human rendering: the tag and its primitive fields. The parent may render its own. */
function describe(tag: string, fields: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(fields)
    .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? `${tag}: ${parts.join(" ")}` : tag;
}

/**
 * Flattens a tagged error for the wire. `fields` is the error's own enumerable payload; a `cause`
 * (non-enumerable on `Data.TaggedError`, and a native driver object besides) stays in this process —
 * `ReaderError.detail` already carries the driver's message.
 */
function toFrame(error: RemoteReaderError): ReaderErrorFrame {
  const { _tag, ...fields } = { ...error } as { _tag: RemoteReaderError["_tag"] } & Record<string, unknown>;
  let safeFields: Record<string, unknown>;
  try {
    safeFields = JSON.parse(stringify(fields));
  } catch {
    safeFields = {};
  }
  return { _tag, message: describe(_tag, safeFields), fields: safeFields };
}

/**
 * `ReaderError.operation` is a closed union (`core/errors.ts`) with no label for "the reply could
 * not be encoded" or "the handler died": every `ReaderError` this process raises outside the
 * transaction steps is attributed to the query itself, `"select"`, and `detail` says what really
 * happened (`handler defect: …`, `unencodable reply: …`). Both are bug-class failures that were
 * already logged in full; a dedicated label needs a `core/errors.ts` change.
 */
const QUERY_OPERATION = "select" as const;

/** The first line of what went wrong, for the caller; the full cause goes to the log. */
function defectDetail(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error && squashed.message) return squashed.message;
  const tag = (squashed as { _tag?: unknown } | null)?._tag;
  return typeof tag === "string" ? `defect: ${tag}` : `defect: ${String(squashed)}`;
}

/** Serializes one reply. Total: a result is JSON-checked by `Reader.query`, an error by `toFrame`. */
function encodeReply(reply: ReaderReply): Uint8Array {
  let line: string;
  try {
    line = stringify(reply);
  } catch (cause) {
    line = stringify({
      id: reply.id,
      error: toFrame(
        new ReaderError({ operation: QUERY_OPERATION, detail: `unencodable reply: ${String(cause)}` }),
      ),
    });
  }
  return encoder.encode(line + "\n");
}

// ---------------------------------------------------------------------------
// The program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const sink = yield* EventSink;
  const readerFor = yield* makeReaderPool();
  const apps = loadApps();
  const pid = Deno.pid;
  const lifecycle = (phase: string, detail?: unknown) => emitLifecycle(sink, phase, detail);

  const answer = (frame: ReaderRequestFrame): Effect.Effect<unknown, RemoteReaderError> => {
    switch (frame.kind) {
      case "ping":
        return Effect.succeed("ready");
      case "query":
        return Effect.gen(function* () {
          const app = apps.get(frame.appId);
          if (!app) return yield* new UnknownAppError({ appId: frame.appId });
          if (!Object.hasOwn(app.functions, frame.name)) {
            return yield* new UnknownHandlerError({ appId: frame.appId, name: frame.name });
          }
          const definition = app.functions[frame.name as keyof typeof app.functions];
          if (definition.kind !== "query") {
            return yield* new HandlerKindMismatch({
              appId: frame.appId,
              name: frame.name,
              expected: "query",
              actual: definition.kind,
            });
          }
          return yield* readerFor(app).query(definition, frame.args);
        });
      // Items 21 and 23 implement these over the event-log DuckDB file.
      case "ingest":
        return Effect.fail(
          new IngestError({ phase: "inventory", detail: "event-log ingest is not available" }),
        );
      case "analysis":
        return Effect.fail(new UnknownAnalysisQuery({ name: frame.name, known: [] }));
    }
  };

  const serve = (frame: ReaderRequestFrame): Effect.Effect<ReaderReply> =>
    answer(frame).pipe(
      Effect.map((result): ReaderReply => ({ id: frame.id, result })),
      Effect.catchAll((error) => Effect.succeed<ReaderReply>({ id: frame.id, error: toFrame(error) })),
      // A defect is a bug (in the platform or in app handler code). Log it in full here; the
      // caller gets a 500-class `ReaderError` without the stack.
      Effect.catchAllCause((cause) =>
        Effect.as(
          Effect.logError("query handler defect", cause),
          {
            id: frame.id,
            error: toFrame(
              new ReaderError({
                operation: QUERY_OPERATION,
                detail: `handler defect: ${defectDetail(cause)}`,
              }),
            ),
          },
        )
      ),
      Effect.annotateLogs({
        traceId: `reader-${pid}-${frame.id}`,
        ...(frame.kind === "query" ? { appId: frame.appId } : {}),
      }),
    );

  const output = yield* Effect.acquireRelease(
    Effect.sync(() => Deno.stdout.writable.getWriter()),
    (writer) => Effect.sync(() => writer.releaseLock()),
  );
  const write = (reply: ReaderReply) =>
    Effect.tryPromise({
      try: () => output.write(encodeReply(reply)),
      catch: (cause) => new IpcError({ reason: "write-failed", detail: String(cause), cause }),
    });

  /** The scoped stdin consumer: frame, serve, reply — strictly one request at a time. */
  const consume = Effect.gen(function* () {
    const input = yield* Effect.acquireRelease(
      Effect.sync(() => Deno.stdin.readable.getReader()),
      (reader) =>
        Effect.sync(() => {
          try {
            reader.releaseLock();
          } catch { /* already released */ }
        }),
    );
    const text = new TextDecoder();
    const frames = decoder();
    const handle = (lines: readonly string[]) =>
      Effect.forEach(lines, (line) => Effect.flatMap(Effect.flatMap(parseFrame(line), serve), write), {
        discard: true,
      });
    while (true) {
      const chunk = yield* Effect.tryPromise({
        try: () => input.read(),
        catch: (cause) => new IpcError({ reason: "stream-failure", detail: String(cause), cause }),
      });
      if (chunk.done) break;
      yield* handle(yield* frames.push(text.decode(chunk.value, { stream: true })));
    }
    yield* handle(yield* frames.push(text.decode()));
    yield* frames.finish();
  }).pipe(Effect.scoped);

  /** Resolves on the first SIGINT/SIGTERM, so the scope closes instead of the process dying mid-write. */
  const signalled = Effect.async<string>((resume) => {
    const on = (signal: Deno.Signal) => () => resume(Effect.succeed(signal));
    const listeners = [["SIGINT", on("SIGINT")], ["SIGTERM", on("SIGTERM")]] as const;
    for (const [signal, listener] of listeners) Deno.addSignalListener(signal, listener);
    return Effect.sync(() => {
      for (const [signal, listener] of listeners) Deno.removeSignalListener(signal, listener);
    });
  });

  yield* lifecycle("ready", { apps: [...apps.keys()] });
  const stopped = yield* Effect.raceFirst(
    Effect.as(consume, "stdin-closed"),
    signalled,
  ).pipe(Effect.tapError((error) => lifecycle("failed", error)));
  yield* lifecycle("stopping", { reason: stopped });
});

/** Config from the environment, and the reader's own JSONL sink + `Effect.log*` replacement. */
const ReaderProcessLive = LoggingReaderLive.pipe(Layer.provideMerge(ConfigLive));

const main = program.pipe(Effect.scoped, Effect.provide(ReaderProcessLive));

// Effect's default logger writes to stdout, which belongs to the RPC protocol. A failure that ends
// the process — including a `ConfigError` raised before the JSONL sink exists — goes to stderr.
const stderrLogger = Logger.replace(Logger.defaultLogger, Logger.withConsoleError(Logger.logfmtLogger));

const exit = await Effect.runPromiseExit(main);
if (Exit.isFailure(exit)) {
  // Name the tagged failure up front: `Data.TaggedError` has no message, so the cause alone would
  // read "An error has occurred".
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  const summary = failure instanceof IpcError || failure instanceof ConfigError
    ? describe(failure._tag, { ...failure })
    : "defect";
  await Effect.runPromise(
    Effect.logError(`reader process failed: ${summary}`, exit.cause).pipe(Effect.provide(stderrLogger)),
  );
}
Deno.exit(Exit.isSuccess(exit) ? 0 : 1);
