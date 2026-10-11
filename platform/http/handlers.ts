/**
 * The endpoint handlers (plan item 22, work 2): one Effect per route, each returning the value that
 * becomes `{ result }` or failing with a `PlatformError` that `router.ts` turns into a status via
 * `toHttpStatus`.
 *
 * Handlers see a `RequestContext`, not a `Request`: the headers, and a body Effect that reads and
 * parses the JSON body under the configured cap only when a handler asks for it. Every handler
 * authenticates before it reads the body, so an unauthenticated caller cannot make the server read
 * 64 KiB. The checks run in the pre-port order, so each failure keeps its status:
 *
 * ```text
 * POST /apps/:appId/:kind/:name   app exists (404) → app token (401) → handler exists (404)
 *                                 → kind matches (400) → body (413/400) → mutation | query
 * POST /admin/backup/:appId       admin token (401) → app exists (404) → Backups.take
 * POST /admin/logs/ingest         admin token (401) → reader: EventLogIngest
 * POST /admin/logs/analysis/:name admin token (401) → params body (413/400) → reader: Analysis
 * GET  /health                    reader ping → { ok, apps }
 * ```
 *
 * Mutations run on the app's own `Storage` (the SQLite writer, in this process). Queries, ingest and
 * analysis go to the reader process through `ReaderClient`, which owns DuckDB — this process never
 * loads it (ADR 0001). The analysis route takes a catalog name and scalar parameters only: no SQL
 * crosses the HTTP boundary, consistent with the repo's "never raw SQL from callers" posture; the
 * reader resolves the name against its catalog and answers `UnknownAnalysisQuery` (404) on a miss.
 */
import { Effect } from "effect";
import {
  type HandlerKind,
  HandlerKindMismatch,
  type PlatformError,
  type RequestTooLarge,
  SchemaError,
  UnknownHandlerError,
} from "../../core/errors.ts";
import { AppServices } from "../registry.ts";
import { AppRegistry, Config, ReaderClient } from "../services.ts";
import { authenticateAdmin, authenticateApp } from "./auth.ts";

/** What a handler may read from the request. */
export interface RequestContext {
  readonly headers: Headers;
  /**
   * The JSON body, read under `Config.server.maxRequestBytes` (`RequestTooLarge` → 413) and parsed
   * (`SchemaError` → 400). An absent or empty body is `{}`. Reads the stream once; run it once.
   */
  readonly body: Effect.Effect<unknown, RequestTooLarge | SchemaError>;
}

/** Every service a handler may use. */
export type HandlerRequirements = Config | AppRegistry | AppServices | ReaderClient;

export type Handler = Effect.Effect<unknown, PlatformError, HandlerRequirements>;

/** `GET /health`: the reader answers a ping, and the apps this process serves. */
export const health: Handler = Effect.gen(function* () {
  const reader = yield* ReaderClient;
  yield* reader.call({ kind: "ping" });
  const apps = yield* (yield* AppRegistry).all;
  return { ok: true, apps: apps.map((app) => app.id) };
});

/** `POST /apps/:appId/:kind/:name`: run one registered handler as a mutation or a query. */
export function invoke(
  context: RequestContext,
  appId: string,
  kind: HandlerKind,
  name: string,
): Handler {
  return Effect.gen(function* () {
    const stack = yield* (yield* AppServices).get(appId);
    yield* authenticateApp(context.headers, stack.app);
    if (!Object.hasOwn(stack.app.functions, name)) {
      return yield* new UnknownHandlerError({ appId, name });
    }
    const definition = stack.app.functions[name];
    if (definition.kind !== kind) {
      return yield* new HandlerKindMismatch({ appId, name, expected: kind, actual: definition.kind });
    }
    const args = yield* context.body;
    if (kind === "mutation") return yield* stack.storage.mutation(definition, args);
    return yield* (yield* ReaderClient).call({ kind: "query", appId, name, args });
  });
}

/** `POST /admin/backup/:appId`: one backup now. `BackupAlreadyRunning` (409) if one is in flight. */
export function backup(context: RequestContext, appId: string): Handler {
  return Effect.gen(function* () {
    yield* authenticateAdmin(context.headers, yield* Config);
    const stack = yield* (yield* AppServices).get(appId);
    return yield* stack.backups.take(appId);
  });
}

/** `POST /admin/logs/ingest`: the reader ingests new JSONL lines into the event-log DuckDB file. */
export function ingestLogs(context: RequestContext): Handler {
  return Effect.gen(function* () {
    yield* authenticateAdmin(context.headers, yield* Config);
    return yield* (yield* ReaderClient).call({ kind: "ingest" });
  });
}

/** A parameter value an analysis query may bind. Objects and arrays are refused. */
type Scalar = string | number | boolean | null;

/**
 * The analysis body: a flat object of scalars, the catalog query's bind parameters. Anything else is
 * a `SchemaError`, so no structured value (and certainly no SQL fragment the reader might be tempted
 * to splice) reaches the reader.
 */
export function analysisParams(body: unknown): Effect.Effect<Readonly<Record<string, Scalar>>, SchemaError> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Effect.fail(new SchemaError({ reason: "not-an-object", path: "params", expected: "object" }));
  }
  const params: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      return Effect.fail(
        new SchemaError({
          reason: "type-mismatch",
          path: `params.${key}`,
          expected: "string, number, boolean or null",
        }),
      );
    }
    params[key] = value as Scalar;
  }
  return Effect.succeed(params);
}

/** `POST /admin/logs/analysis/:name`: run one named catalog query with the body as its parameters. */
export function analysis(context: RequestContext, name: string): Handler {
  return Effect.gen(function* () {
    yield* authenticateAdmin(context.headers, yield* Config);
    const params = yield* analysisParams(yield* context.body);
    return yield* (yield* ReaderClient).call({ kind: "analysis", name, params });
  });
}
