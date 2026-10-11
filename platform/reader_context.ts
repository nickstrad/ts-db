/**
 * Request reception for the reader process (plan item 33): one stdin line becomes a validated
 * `ReaderRequestFrame` plus the caller's trace context, and that context annotates the request's
 * Effect so every log record the request produces carries it. Events carry less: a query's `sql`
 * and `tx` events take its `traceId` (not its `spanId`); ingest and seal events use
 * `ingest-<runId>`, retention events `retention-<uuid>`, lifecycle events `reader-lifecycle`.
 * Threading the context into those is item 34's.
 *
 * ## Wire properties
 *
 * A request object may carry three optional string properties beside the frozen
 * `ReaderRequestFrame` fields: `traceId`, `spanId` and `parentSpanId`. They are read off the parsed
 * JSON as *unknown* values, before the object is narrowed to `ReaderRequestFrame`, so this module
 * needs no change to `platform/services.ts`; item 34 owns extending the declared wire type and the
 * sending side.
 *
 * Each value must match `TRACE_TOKEN` — the same bound the HTTP ingress applies to `X-Trace-Id`
 * (`platform/http/router.ts`). A missing value is normal (an old sender); an invalid one is ignored,
 * never a protocol violation: a bad trace must not end the process that serves every query. Ignored
 * fields — invalid ones, and valid spans dropped for want of a trace (below) — are listed in the
 * request's `ignoredTraceFields` annotation.
 *
 * ## Resolution
 *
 * - A valid caller `traceId` is used as it is; nothing here replaces it.
 * - Without one, the reader-local fallback `reader-<pid>-<id>` applies, exactly as before item 33.
 * - `spanId` and `parentSpanId` are honored only beside a valid caller `traceId`: a span without its
 *   trace cannot be placed. When no caller span is usable, a reader-local `spanId` comes from
 *   `IdGen`, so two requests that share a trace remain distinguishable in the log.
 *
 * `traceOrigin` (`"caller"` or `"reader"`) records which case applied. This prepares the receiving
 * half of item 34's end-to-end contract; it does not by itself make any caller send a trace.
 */
import { Effect } from "effect";
import { IpcError } from "../core/errors.ts";
import { IdGen, type ReaderRequestFrame } from "./services.ts";

/** The optional trace properties a request frame may carry. */
export const TRACE_FIELDS = ["traceId", "spanId", "parentSpanId"] as const;
export type TraceField = (typeof TRACE_FIELDS)[number];

/** What a trace or span id may look like on the wire: the HTTP ingress's `X-Trace-Id` bound. */
export const TRACE_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The trace properties found on one request, validated; `ignored` names those present but invalid. */
export interface WireTraceContext {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly ignored: readonly TraceField[];
}

/** One received request: the narrowed frame and the trace properties read beside it. */
export interface ReceivedRequest {
  readonly frame: ReaderRequestFrame;
  readonly trace: WireTraceContext;
}

/** The context one request runs under. */
export interface RequestContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly origin: "caller" | "reader";
  readonly ignored: readonly TraceField[];
}

/**
 * Reads the optional trace properties off a parsed request object. Total: an absent property is
 * skipped, a present one that is not a `TRACE_TOKEN` string is reported in `ignored`.
 */
export function readTraceContext(value: Readonly<Record<string, unknown>>): WireTraceContext {
  const found: { -readonly [K in TraceField]?: string } = {};
  const ignored: TraceField[] = [];
  for (const field of TRACE_FIELDS) {
    if (!Object.hasOwn(value, field) || value[field] === undefined) continue;
    const candidate = value[field];
    if (typeof candidate === "string" && TRACE_TOKEN.test(candidate)) found[field] = candidate;
    else ignored.push(field);
  }
  return { ...found, ignored };
}

/**
 * Parses and validates one request line. The trace properties are read from the unknown JSON first;
 * then the object is checked against the frozen `ReaderRequestFrame` shape. A line that is not a
 * well-formed frame fails `IpcError("malformed-frame")`; an invalid trace property never does.
 */
export function receiveFrame(line: string): Effect.Effect<ReceivedRequest, IpcError> {
  return Effect.gen(function* () {
    const value: unknown = yield* Effect.try({
      try: () => JSON.parse(line),
      catch: (cause) => new IpcError({ reason: "malformed-frame", detail: "request is not JSON", cause }),
    });
    const malformed = (detail: string) => Effect.fail(new IpcError({ reason: "malformed-frame", detail }));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return yield* malformed("request is not an object");
    }
    const record = value as Record<string, unknown>;
    const trace = readTraceContext(record);
    if (typeof record.id !== "number" || !Number.isSafeInteger(record.id)) {
      return yield* malformed("request id is not an integer");
    }
    switch (record.kind) {
      case "ping":
      case "ingest":
        break;
      case "query":
        if (typeof record.appId !== "string" || typeof record.name !== "string") {
          return yield* malformed("query request needs string appId and name");
        }
        break;
      case "analysis":
        if (typeof record.name !== "string" || typeof record.params !== "object" || record.params === null) {
          return yield* malformed("analysis request needs a name and params");
        }
        break;
      default:
        return yield* malformed(`unknown request kind ${JSON.stringify(record.kind)}`);
    }
    return { frame: record as unknown as ReaderRequestFrame, trace };
  });
}

/** The trace id a request without a usable caller trace runs under. Unchanged since item 16. */
export function fallbackTraceId(pid: number, requestId: number): string {
  return `reader-${pid}-${requestId}`;
}

/** Resolves the context for one request; see the module comment for the rules. */
export function resolveRequestContext(
  received: ReceivedRequest,
  pid: number,
): Effect.Effect<RequestContext, never, IdGen> {
  return Effect.gen(function* () {
    const { frame, trace } = received;
    if (trace.traceId !== undefined) {
      return {
        traceId: trace.traceId,
        spanId: trace.spanId ?? (yield* (yield* IdGen).next),
        ...(trace.parentSpanId === undefined ? {} : { parentSpanId: trace.parentSpanId }),
        origin: "caller" as const,
        ignored: trace.ignored,
      };
    }
    return {
      traceId: fallbackTraceId(pid, frame.id),
      spanId: yield* (yield* IdGen).next,
      origin: "reader" as const,
      ignored: trace.ignored,
    };
  });
}

/**
 * The trace fields the log names as unused: the invalid ones, plus any valid `spanId` /
 * `parentSpanId` that a missing trace left unplaceable, so the log still shows the caller sent them.
 */
function unusedTraceFields(trace: WireTraceContext, context: RequestContext): readonly TraceField[] {
  if (context.origin === "caller") return context.ignored;
  return TRACE_FIELDS.filter((field) =>
    context.ignored.includes(field) || (field !== "traceId" && trace[field] !== undefined)
  );
}

/** The log annotations one request carries: its context, plus the app for a query. */
export function requestAnnotations(
  received: ReceivedRequest,
  context: RequestContext,
): Record<string, unknown> {
  const { frame, trace } = received;
  const unused = unusedTraceFields(trace, context);
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    ...(context.parentSpanId === undefined ? {} : { parentSpanId: context.parentSpanId }),
    traceOrigin: context.origin,
    ...(unused.length === 0 ? {} : { ignoredTraceFields: unused }),
    ...(frame.kind === "query" ? { appId: frame.appId } : {}),
  };
}

/** Runs `effect` annotated with the request's context, resolved from what was received. */
export function withRequestContext<A, E, R>(
  received: ReceivedRequest,
  pid: number,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | IdGen> {
  return Effect.flatMap(
    resolveRequestContext(received, pid),
    (context) => Effect.annotateLogs(effect, requestAnnotations(received, context)),
  );
}
