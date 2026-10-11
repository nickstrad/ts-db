/**
 * The HTTP surface (plan item 22, works 2, 4 and 5): routing, the request-body cap, the
 * error-to-status mapping, and per-request tracing — one `Request` in, one `Response` out, as an
 * Effect that cannot fail.
 *
 * ## Routes
 *
 * The pre-port regex shapes, unchanged, plus the two admin log routes:
 *
 * ```text
 * GET  /health                                       handlers.health
 * POST /apps/:appId/(query|mutation)/:name           handlers.invoke      name: [A-Za-z][A-Za-z0-9_]*
 * POST /admin/backup/:appId                          handlers.backup
 * POST /admin/logs/ingest                            handlers.ingestLogs
 * POST /admin/logs/analysis/:name                    handlers.analysis    name: [A-Za-z][A-Za-z0-9_-]*
 * anything else                                      RouteNotFound (404)
 * ```
 *
 * Path segments are matched raw (no percent-decoding), as before the port: an id that is not a
 * registered app simply answers 404.
 *
 * ## Responses
 *
 * Success is `200 { result }`. Failure is `toHttpStatus(error)` with
 * `{ error: { tag, message } }`: the `error` key is the one `sdk/client.ts` has always read, and the
 * client now also reads `tag` into `RemoteError.remoteTag`. A 5xx message names only the tag and the
 * trace id — the structured detail (driver messages, paths) goes to the `http` event, not to the
 * caller. A defect (a bug, not a typed failure) is a 500 with tag `Defect`, logged in full.
 *
 * ## Tracing
 *
 * Every request runs under one trace id: the caller's `X-Trace-Id` when it is a plausible id
 * (1–128 of `[A-Za-z0-9._:-]`), otherwise a fresh one from `IdGen`. It is attached with
 * `Effect.annotateLogs` (plus `appId` on app routes), so every event the request's fiber emits —
 * the SQLite writer's `sql`/`tx`, a backup's phases, any `Effect.log*` — carries it; it is echoed in
 * the `X-Trace-Id` response header; and the request ends with exactly one `http` event (method, path,
 * app, handler, status, duration, bytes in/out, and the error tag on a failure).
 *
 * The `http` event's `handlerKind`/`name` columns are typed for app handlers (`query`|`mutation`).
 * Platform routes fill them as: `/health` → `query`/`health`; `/admin/backup` →
 * `mutation`/`admin.backup`; `/admin/logs/ingest` → `mutation`/`admin.logs.ingest`;
 * `/admin/logs/analysis/:name` → `query`/`admin.logs.analysis.<name>`; an unmatched route →
 * `query` for GET/HEAD, `mutation` otherwise, with an empty name.
 */
import { Cause, Clock, Effect, Option } from "effect";
import {
  type AnyError,
  type HandlerKind,
  type PlatformError,
  RequestTooLarge,
  RouteNotFound,
  SchemaError,
  toHttpStatus,
} from "../../core/errors.ts";
import { fromPlatformError, httpEvent, type Level } from "../../core/events.ts";
import { Config, EventSink, IdGen } from "../services.ts";
import * as handlers from "./handlers.ts";
import type { Handler, HandlerRequirements, RequestContext } from "./handlers.ts";

/** What `handle` needs: the handlers' services, plus the sink for the `http` event and ids for traces. */
export type RouterRequirements = HandlerRequirements | EventSink | IdGen;

/** The trace-id header, read from the request and echoed on the response. */
export const TRACE_HEADER = "x-trace-id";

const TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const APP_ROUTE = /^\/apps\/([^/]+)\/(query|mutation)\/([A-Za-z][A-Za-z0-9_]*)$/;
const BACKUP_ROUTE = /^\/admin\/backup\/([^/]+)$/;
const ANALYSIS_ROUTE = /^\/admin\/logs\/analysis\/([A-Za-z][A-Za-z0-9_-]*)$/;

/** One matched route: what to run, and how the `http` event names it. */
export interface Route {
  readonly handlerKind: HandlerKind;
  readonly name: string;
  readonly appId?: string;
  readonly run: (context: RequestContext) => Handler;
}

/** Matches a method and path against the route table. `None` is a 404. */
export function matchRoute(method: string, path: string): Option.Option<Route> {
  if (method === "GET" && path === "/health") {
    return Option.some({ handlerKind: "query", name: "health", run: () => handlers.health });
  }
  if (method !== "POST") return Option.none();
  const app = path.match(APP_ROUTE);
  if (app) {
    const [, appId, kind, name] = app;
    const handlerKind = kind as HandlerKind;
    return Option.some({
      handlerKind,
      name,
      appId,
      run: (context) => handlers.invoke(context, appId, handlerKind, name),
    });
  }
  const backup = path.match(BACKUP_ROUTE);
  if (backup) {
    const appId = backup[1];
    return Option.some({
      handlerKind: "mutation",
      name: "admin.backup",
      appId,
      run: (context) => handlers.backup(context, appId),
    });
  }
  if (path === "/admin/logs/ingest") {
    return Option.some({ handlerKind: "mutation", name: "admin.logs.ingest", run: handlers.ingestLogs });
  }
  const analysis = path.match(ANALYSIS_ROUTE);
  if (analysis) {
    const name = analysis[1];
    return Option.some({
      handlerKind: "query",
      name: `admin.logs.analysis.${name}`,
      run: (context) => handlers.analysis(context, name),
    });
  }
  return Option.none();
}

// ===========================================================================
// Request body
// ===========================================================================

/**
 * Reads `request`'s body under `limit` bytes and parses it as JSON. An absent or empty body is `{}`.
 * Crossing the cap cancels the stream (the rest is never read) and fails `RequestTooLarge`;
 * malformed JSON fails `SchemaError`. `counted` is told every byte read, for the `http` event.
 */
export function readJsonBody(
  request: Request,
  limit: number,
  counted: (bytes: number) => void,
): Effect.Effect<unknown, RequestTooLarge | SchemaError> {
  return Effect.gen(function* () {
    const body = request.body;
    if (!body) return {};
    const bytes = yield* Effect.acquireUseRelease(
      Effect.sync(() => body.getReader()),
      (reader) =>
        Effect.gen(function* () {
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const chunk = yield* Effect.promise(() => reader.read());
            if (chunk.done) break;
            size += chunk.value.length;
            counted(chunk.value.length);
            if (size > limit) {
              yield* Effect.promise(() => reader.cancel().catch(() => {}));
              return yield* new RequestTooLarge({ limit, observed: size });
            }
            chunks.push(chunk.value);
          }
          const all = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
          }
          return all;
        }),
      (reader) => Effect.sync(() => reader.releaseLock()),
    );
    const text = new TextDecoder().decode(bytes);
    if (text.trim() === "") return {};
    return yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new SchemaError({ reason: "type-mismatch", path: "body", expected: "JSON" }),
    });
  });
}

// ===========================================================================
// Error rendering
// ===========================================================================

/** `key=value` for an error's primitive fields: the generic rendering for 4xx messages. */
function fieldsOf(error: PlatformError): string {
  return Object.entries(error as unknown as Record<string, unknown>)
    .filter(([key, value]) =>
      key !== "_tag" && (value === null || ["string", "number", "boolean"].includes(typeof value))
    )
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

/**
 * The human message for a failure. 4xx messages say what was wrong with the request; 5xx messages
 * say only which tag failed and where to look, since their detail is about this server.
 */
export function errorMessage(error: PlatformError, status: number, traceId: string): string {
  if (status >= 500) return `${error._tag}; see the server log for trace ${traceId}`;
  switch (error._tag) {
    case "AuthError":
      return "Unauthorized";
    case "RouteNotFound":
      return `Not found: ${error.method} ${error.path}`;
    case "UnknownAppError":
      return `Unknown app: ${error.appId}`;
    case "UnknownHandlerError":
      return `Unknown handler: ${error.name}`;
    case "HandlerKindMismatch":
      return `Handler kind mismatch: ${
        error.name ?? "handler"
      } is a ${error.actual}, not a ${error.expected}`;
    case "RequestTooLarge":
      return `Request exceeds ${error.limit} bytes`;
    case "ConflictError":
      return `Version conflict: expected ${error.expected}, found ${error.actual}`;
    case "NotFoundError":
      return `Document not found: ${error.table} ${error.id}`;
  }
  // A reader-side error arrives with the reader's own rendering as its `message`.
  if (error.message) return error.message;
  const fields = fieldsOf(error);
  return fields ? `${error._tag}: ${fields}` : error._tag;
}

// ===========================================================================
// The request pipeline
// ===========================================================================

interface Outcome {
  readonly status: number;
  readonly body: unknown;
  readonly error?: AnyError;
  readonly defect?: Cause.Cause<never>;
}

function levelOf(status: number): Level {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

const encoder = new TextEncoder();

/**
 * One request, start to finish. Never fails: every typed failure becomes its status, and a defect
 * becomes a 500 — logged with its cause under the request's trace id.
 */
export function handle(request: Request): Effect.Effect<Response, never, RouterRequirements> {
  return Effect.gen(function* () {
    const started = yield* Clock.currentTimeNanos;
    const presented = request.headers.get(TRACE_HEADER);
    const traceId = presented !== null && TRACE_ID.test(presented) ? presented : yield* (yield* IdGen).next;
    const { pathname: path } = new URL(request.url);
    const route = matchRoute(request.method, path);
    const appId = Option.getOrUndefined(route)?.appId;

    let bytesIn = 0;
    const config = yield* Config;
    const body = yield* Effect.cached(
      readJsonBody(request, config.server.maxRequestBytes, (n) => void (bytesIn += n)),
    );
    const context: RequestContext = { headers: request.headers, body };

    const run: Handler = Option.match(route, {
      onNone: () => Effect.fail(new RouteNotFound({ method: request.method, path })),
      onSome: (matched) => matched.run(context),
    });

    const outcome: Outcome = yield* run.pipe(
      Effect.map((result): Outcome => ({ status: 200, body: { result } })),
      Effect.catchAll((error) => {
        const status = toHttpStatus(error);
        return Effect.succeed<Outcome>({
          status,
          body: { error: { tag: error._tag, message: errorMessage(error, status, traceId) } },
          error,
        });
      }),
      Effect.catchAllCause((cause) =>
        Effect.as(Effect.logError("request handler defect", cause), {
          status: 500,
          body: { error: { tag: "Defect", message: `Defect; see the server log for trace ${traceId}` } },
          defect: cause,
        })
      ),
      Effect.annotateLogs(appId === undefined ? { traceId } : { traceId, appId }),
    );

    const text = JSON.stringify(outcome.body);
    const bytesOut = encoder.encode(text).length;
    const finished = yield* Clock.currentTimeNanos;
    const matched = Option.getOrUndefined(route);
    const columns = outcome.error
      ? fromPlatformError(outcome.error)
      : outcome.defect
      ? { errorTag: "Defect", errorDetail: { message: Cause.pretty(outcome.defect).split("\n")[0] } }
      : undefined;
    yield* (yield* EventSink).emit(httpEvent({
      eventId: yield* (yield* IdGen).next,
      ts: new Date(Number(finished / 1_000_000n)).toISOString(),
      level: levelOf(outcome.status),
      role: "server",
      pid: Deno.pid,
      traceId,
      ...(appId === undefined ? {} : { appId }),
      method: request.method,
      path,
      handlerKind: matched?.handlerKind ??
        (request.method === "GET" || request.method === "HEAD" ? "query" : "mutation"),
      name: matched?.name ?? "",
      status: outcome.status,
      durationMs: Number(finished - started) / 1e6,
      bytesIn,
      bytesOut,
      ...(columns ?? {}),
    }));

    return new Response(text, {
      status: outcome.status,
      headers: { "content-type": "application/json", [TRACE_HEADER]: traceId },
    });
  });
}
