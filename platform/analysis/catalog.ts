/** Named, bound, read-only analysis of the persistent event log. Reader-side only. */
import { DuckDBInstance } from "@duckdb/node-api";
import { Effect, Layer } from "effect";
import { AnalysisError, UnknownAnalysisQuery } from "../../core/errors.ts";
import { Analysis, type AnalysisService, Config } from "../services.ts";

export interface AnalysisParam {
  readonly name: string;
  readonly type: "timestamp" | "string";
  readonly required: boolean;
}

export interface AnalysisQuery {
  readonly sql: string;
  readonly params: readonly AnalysisParam[];
  readonly description: string;
}

const timeParams: readonly AnalysisParam[] = [
  { name: "since", type: "timestamp", required: false },
  { name: "until", type: "timestamp", required: false },
];

// TIMESTAMP columns contain UTC wall time. Bind ISO instants as TIMESTAMPTZ first,
// so offsets supplied by callers are honoured independently of the session timezone.
const window = (column = "ts") =>
  `($since::TIMESTAMPTZ IS NULL OR ${column} >= ($since::TIMESTAMPTZ AT TIME ZONE 'UTC'))
    AND ($until::TIMESTAMPTZ IS NULL OR ${column} < ($until::TIMESTAMPTZ AT TIME ZONE 'UTC'))`;
const percentiles = `quantile_cont(duration_ms, 0.50) AS p50_ms,
  quantile_cont(duration_ms, 0.95) AS p95_ms,
  quantile_cont(duration_ms, 0.99) AS p99_ms`;

/** Only these SQL strings reach the driver. Parameter values are never interpolated. */
export const catalog: Readonly<Record<string, AnalysisQuery>> = Object.freeze({
  "slowest-sql": {
    description: "SQL duration p50/p95/p99 by engine, statement kind and table.",
    params: timeParams,
    sql: `SELECT engine, statement_kind, table_name, count(*) AS executions, ${percentiles}
FROM sql_events WHERE ${window()}
GROUP BY engine, statement_kind, table_name
ORDER BY p95_ms DESC NULLS LAST, engine, statement_kind, table_name`,
  },
  "plan-shapes": {
    description: "Distinct compiled SQL texts, their execution counts and latency.",
    params: timeParams,
    sql: `SELECT engine, dialect, statement_kind, table_name, sql_text,
  count(*) AS executions, ${percentiles}
FROM sql_events WHERE ${window()}
GROUP BY engine, dialect, statement_kind, table_name, sql_text
ORDER BY executions DESC, engine, sql_text`,
  },
  "error-rate-by-handler": {
    description: "Request count, error rate and error-tag mix per app and handler.",
    params: timeParams,
    sql: `WITH requests AS (
  SELECT *, (status >= 400 OR error_tag IS NOT NULL) AS failed
  FROM http_events WHERE ${window()} AND kind IN ('query', 'mutation')
), totals AS (
  SELECT app_id, kind, name, count(*) AS requests,
    count(*) FILTER (WHERE failed) AS errors,
    count(*) FILTER (WHERE failed)::DOUBLE / count(*) AS error_rate
  FROM requests GROUP BY app_id, kind, name
), tags AS (
  SELECT app_id, kind, name, coalesce(error_tag, 'HTTP ' || status::VARCHAR) AS error_tag,
    count(*) AS error_count FROM requests WHERE failed
  GROUP BY app_id, kind, name, coalesce(error_tag, 'HTTP ' || status::VARCHAR)
)
SELECT t.*, e.error_tag, coalesce(e.error_count, 0) AS error_count
FROM totals t LEFT JOIN tags e
  ON t.app_id IS NOT DISTINCT FROM e.app_id AND t.kind = e.kind
  AND t.name IS NOT DISTINCT FROM e.name
ORDER BY t.error_rate DESC, t.app_id, t.kind, t.name, e.error_tag`,
  },
  "mutation-vs-query-latency": {
    description: "Mutation (writer) versus query (reader) handler latency by minute.",
    params: timeParams,
    sql: `SELECT date_trunc('minute', ts) AS minute, app_id, kind,
  count(*) AS executions, ${percentiles}
FROM http_events WHERE ${window()} AND kind IN ('query', 'mutation')
GROUP BY minute, app_id, kind ORDER BY minute, app_id, kind`,
  },
  "handler-throughput": {
    description: "Requests per minute per app and handler, with HTTP status breakdown.",
    params: timeParams,
    sql: `SELECT date_trunc('minute', ts) AS minute, app_id, kind, name, status,
  count(*) AS requests FROM http_events
WHERE ${window()} AND kind IN ('query', 'mutation')
GROUP BY minute, app_id, kind, name, status ORDER BY minute, app_id, kind, name, status`,
  },
  "queue-depth": {
    description: "Queue high-water marks, rejections and dropped events by minute.",
    params: timeParams,
    sql: `SELECT date_trunc('minute', ts) AS minute, queue, max(depth) AS max_depth,
  max(cap) AS max_cap, count(*) FILTER (WHERE event = 'high-water') AS high_water_events,
  count(*) FILTER (WHERE event = 'rejected') AS rejections,
  count(*) FILTER (WHERE event = 'dropped') AS drop_reports,
  coalesce(sum(dropped) FILTER (WHERE event = 'dropped'), 0) AS dropped_events
FROM queue_events WHERE ${window()}
GROUP BY minute, queue ORDER BY minute, queue`,
  },
  "tx-outcomes": {
    description: "Commit, rollback and interrupted transaction counts and queue wait times.",
    params: timeParams,
    sql: `SELECT app_id, engine, outcome, count(*) AS transactions,
  sum(operations) AS operations, avg(queue_wait_ms) AS mean_queue_wait_ms,
  quantile_cont(queue_wait_ms, 0.95) AS p95_queue_wait_ms, ${percentiles}
FROM tx_events WHERE ${window()}
GROUP BY app_id, engine, outcome ORDER BY app_id, engine, outcome`,
  },
  "backup-history": {
    description: "Backup phases, durations, bytes, failures and gaps between completed backups.",
    params: timeParams,
    // Compute the previous completion before filtering the window: it may precede `since`.
    sql: `WITH history AS (
  SELECT *, max(ts) FILTER (WHERE phase = 'publish-latest' AND outcome = 'ok') OVER (
    PARTITION BY app_id ORDER BY ts, phase, key, outcome
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS previous_success_at FROM backup_events
)
SELECT ts, app_id, phase, key, bytes, sha256, duration_ms, outcome, error_tag,
  CASE WHEN phase = 'publish-latest' AND outcome = 'ok'
    THEN epoch(ts - previous_success_at) END AS gap_seconds
FROM history WHERE ${window()} ORDER BY ts, app_id, phase, key`,
  },
  trace: {
    description: "Complete ordered platform event timeline for one trace across both processes.",
    params: [{ name: "traceId", type: "string", required: true }],
    // Every accepted JSONL event has one canonical platform row. Unioning typed tables
    // would duplicate SQL/HTTP/transaction events and omit backup/lifecycle trace identity.
    sql: `SELECT * FROM platform_events WHERE trace_id = $traceId
ORDER BY ts, source_file, source_offset, event_id`,
  },
  "k6-vs-platform": {
    description: "k6 client p95 and traced server handler p95 per 10-second bucket and scenario.",
    params: timeParams,
    sql: `WITH client_points AS (
  SELECT time_bucket(INTERVAL '10 seconds', ts) AS bucket, scenario, trace_id, value
  FROM k6_points WHERE ${window()} AND metric = 'http_req_duration'
), clients AS (
  SELECT bucket, scenario, count(*) AS client_samples,
    quantile_cont(value, 0.95) AS client_p95_ms
  FROM client_points GROUP BY bucket, scenario
), requests AS (
  SELECT row_number() OVER () AS request_id, ts, trace_id, duration_ms
  FROM http_events WHERE ${window()} AND kind IN ('query', 'mutation')
), matched_handlers AS (
  SELECT DISTINCT k.bucket, k.scenario, p.request_id, p.duration_ms
  FROM client_points k JOIN requests p ON k.trace_id = p.trace_id
    AND k.bucket = time_bucket(INTERVAL '10 seconds', p.ts)
  WHERE k.trace_id IS NOT NULL AND k.trace_id <> ''
), handlers AS (
  SELECT bucket, scenario, count(*) AS handler_samples,
    quantile_cont(duration_ms, 0.95) AS handler_p95_ms
  FROM matched_handlers GROUP BY bucket, scenario
)
SELECT c.*, h.handler_samples, h.handler_p95_ms FROM clients c JOIN handlers h
  ON c.bucket = h.bucket AND c.scenario IS NOT DISTINCT FROM h.scenario
ORDER BY c.bucket, c.scenario`,
  },
});

export const analysisNames: readonly string[] = Object.freeze(Object.keys(catalog));

/** Validate even before opening the database, so an unknown name always has the same error. */
export function analysisQuery(name: string): Effect.Effect<AnalysisQuery, UnknownAnalysisQuery> {
  return Object.hasOwn(catalog, name)
    ? Effect.succeed(catalog[name])
    : Effect.fail(new UnknownAnalysisQuery({ name, known: analysisNames }));
}

function bindParams(query: AnalysisQuery, params: Readonly<Record<string, unknown>>) {
  const values: Record<string, string | null> = {};
  for (const key of Object.keys(params)) {
    if (!query.params.some((param) => param.name === key)) throw new Error(`Unknown parameter: ${key}`);
  }
  for (const param of query.params) {
    const value = params[param.name];
    if (value === undefined || value === null) {
      if (param.required) throw new Error(`Required parameter: ${param.name}`);
      values[param.name] = null;
    } else {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${param.name} must be a non-empty string`);
      }
      if (param.type === "timestamp") {
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) ||
          !Number.isFinite(Date.parse(value))
        ) {
          throw new Error(`${param.name} must be an ISO timestamp with a timezone`);
        }
        values[param.name] = new Date(value).toISOString();
      } else values[param.name] = value;
    }
  }
  if (values.since && values.until && values.since >= values.until) {
    throw new Error("since must precede until");
  }
  return values;
}

/** Lazy per-call native scopes keep list/name validation independent of database availability. */
export const AnalysisLive: Layer.Layer<Analysis, never, Config> = Layer.effect(
  Analysis,
  Effect.map(Config, (config): AnalysisService => ({
    names: Effect.succeed(analysisNames),
    run: (name, params) =>
      Effect.gen(function* () {
        const query = yield* analysisQuery(name);
        const fail = (cause: unknown) => new AnalysisError({ name, detail: String(cause), cause });
        const values = yield* Effect.try({ try: () => bindParams(query, params), catch: fail });
        const close = (handle: { closeSync(): void }) =>
          Effect.try(() => handle.closeSync()).pipe(Effect.catchAll(Effect.logWarning));
        // The native API cannot cancel an in-flight promise. Wait for it before closing its handles.
        return yield* Effect.scoped(Effect.gen(function* () {
          const instance = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                DuckDBInstance.create(config.eventLog.duckdbPath, {
                  access_mode: "READ_ONLY",
                  threads: "2",
                  memory_limit: "256MB",
                }),
              catch: fail,
            }),
            close,
          );
          const connection = yield* Effect.acquireRelease(
            Effect.tryPromise({ try: () => instance.connect(), catch: fail }),
            close,
          );
          return yield* Effect.tryPromise({
            try: async () => (await connection.runAndReadAll(query.sql, values)).getRowObjectsJson(),
            catch: fail,
          });
        })).pipe(Effect.uninterruptible);
      }),
  })),
);
