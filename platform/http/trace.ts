/**
 * Caller trace context (plan item 34): the one contract for how a request's trace id and span ids
 * are accepted at HTTP ingress, carried through the server's fibers, and handed to the reader child.
 *
 * ## The model
 *
 * A **trace** is one caller operation; every event any process records for it carries its
 * `traceId`. A **span** is one unit of work inside a trace; `spanId` names it and `parentSpanId`
 * names the span that started it. Three spans exist per app request today:
 *
 * ```text
 * HTTP ingress (router.ts)        traceId                     → `http` event
 *   handler span (handlers.ts)    traceId, spanId H           → `handler`, SQLite `sql`/`tx`, logs
 *     reader RPC span (ipc.ts)    traceId, spanId R, parent H → reader `sql`/`tx`, reader logs
 * ```
 *
 * The context lives in the fiber's log annotations (`traceId`, `spanId`, `parentSpanId`), because
 * that is what every existing emitter already reads: `logger.ts` promotes `traceId`/`spanId` into the
 * envelope of each `Effect.log*` record, `sqlite.ts` stamps both on its `sql`/`tx`/`queue` events,
 * and `duckdb.ts` stamps `traceId` on the reader's (`reader_context.ts` restores the annotations in
 * the child). Annotations are fiber-local and inherited by forked fibers, so two overlapping
 * requests can never see each other's context.
 *
 * Correlation ids are not trace ids: the reader IPC's numeric request `id` pairs a reply with its
 * call and is never logged as a `traceId`, and an event's `eventId` is its own identity. The reader's
 * fallback for a frame that carries no trace, `reader-<pid>-<requestId>`, embeds the correlation id
 * only because it has nothing better.
 *
 * ## HTTP ingress
 *
 * `X-Trace-Id` (`TRACE_HEADER`) is accepted when it is a `TRACE_TOKEN`: 1–128 characters of
 * `[A-Za-z0-9._:-]`, the same bound the reader applies to the wire properties. Anything else —
 * absent, empty, too long, a space, a comma-joined repeat of the header, non-ASCII — is *not an
 * error*: the request runs under a freshly generated id instead, because a bad trace header must
 * never cost the caller their request. Either way the id the request actually ran under is echoed in
 * the response's `X-Trace-Id`, on every status (success, 4xx, 5xx, a defect), so a caller whose id
 * was replaced learns the replacement. `ingressTraceId` states that rule; `platform/http/router.ts`
 * applies the same rule with its own copy of the pattern, and `tests/unit/trace_test.ts` holds the
 * router to it.
 *
 * The SDK client (`sdk/client.ts`) sends the caller's id verbatim or, without one, a generated UUID,
 * which is always a `TRACE_TOKEN`. Ingress is the single place an id is judged.
 *
 * k6 load scripts (`perf/lib/api.js`) also send `X-Trace-Id`, but nothing joins k6 output to these
 * events yet; that producer is item 25's.
 */
import { Effect, FiberRef, HashMap, Option } from "effect";

/**
 * What a trace or span id may look like, at HTTP ingress and on the reader wire. The reader declares
 * the same bound as `platform/reader_context.ts`'s `TRACE_TOKEN`; it is restated here, not imported,
 * because that module is reader-only and the server must never load it (item 33's import-graph
 * test). `tests/unit/trace_test.ts` fails if the two ever differ.
 */
export const TRACE_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The trace header, read from the request and echoed on the response. Header names are case-insensitive. */
export const TRACE_HEADER = "x-trace-id";

/** Whether `value` may be used as a trace or span id. */
export function isTraceToken(value: unknown): value is string {
  return typeof value === "string" && TRACE_TOKEN.test(value);
}

/**
 * The trace id ingress accepts from a presented `X-Trace-Id` value (`Headers.get`'s result).
 * `None` — absent or invalid — means the request runs under a generated id.
 */
export function ingressTraceId(presented: string | null): Option.Option<string> {
  return isTraceToken(presented) ? Option.some(presented) : Option.none();
}

/** One fiber's trace context: a trace, and the span within it that is currently running. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
}

/**
 * The trace context of the running fiber, read from its log annotations. `None` outside any traced
 * request (a timer, startup). A `spanId`/`parentSpanId` annotation that is not a `TRACE_TOKEN` is
 * left out rather than propagated.
 */
export const currentTraceContext: Effect.Effect<Option.Option<TraceContext>> = Effect.map(
  Effect.logAnnotations,
  (annotations) => {
    const token = (key: string) =>
      Option.getOrUndefined(Option.filter(HashMap.get(annotations, key), isTraceToken));
    const traceId = token("traceId");
    if (traceId === undefined) return Option.none();
    const spanId = token("spanId");
    const parentSpanId = token("parentSpanId");
    return Option.some({
      traceId,
      ...(spanId === undefined ? {} : { spanId }),
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
    });
  },
);

/** A fresh span id. Opaque, and always a `TRACE_TOKEN`. */
export const newSpanId: Effect.Effect<string> = Effect.sync(() => crypto.randomUUID());

/**
 * Runs `effect` as a new child span of the current one: the given id becomes the `spanId`
 * annotation, and the span that was running (if any) becomes `parentSpanId`. The trace id is
 * inherited unchanged. Outside a trace the annotations are still set, so the span's own events stay
 * joinable with each other.
 */
export function withChildSpan<A, E, R>(
  spanId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.locallyWith(effect, FiberRef.currentLogAnnotations, (annotations) => {
    const parent = Option.filter(HashMap.get(annotations, "spanId"), isTraceToken);
    const child = HashMap.set(annotations, "spanId", spanId as unknown);
    // An outer `parentSpanId` belongs to the outer span; a root span has none.
    return Option.isSome(parent)
      ? HashMap.set(child, "parentSpanId", parent.value as unknown)
      : HashMap.remove(child, "parentSpanId");
  });
}
