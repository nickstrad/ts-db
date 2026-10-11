/**
 * End-to-end observability check (plan item 25): k6 client-side latency joined to the server's own
 * handler durations, both read back out of DuckDB.
 *
 * ```text
 * scratch server ──k6 smoke (30 s)──> logs/k6/<run>/raw.json ──perf/ingest_k6.ts──> k6.duckdb : k6_points
 *       │                                                                                 │
 *       └─ JSONL ──POST /admin/logs/ingest──> eventlog.duckdb : platform_events ──ATTACH──┘
 *                                                                     k6-vs-platform join
 * ```
 *
 * The join buckets both sides by `time_bucket(INTERVAL 10 seconds, ts)`: client p95 of k6's
 * `http_req_duration` for the run, and server p95 of `handler` `duration_ms` for the requests whose
 * trace id k6 minted for the run (`perf/lib/api.js`: `<vu>-<iter>-<run id>`). Both processes run on
 * this machine, so their wall clocks bucket alike. The assertions:
 *
 * - the join returns rows, and every bucket either side has is matched on the other;
 * - client p95 >= server p95 in every bucket. Not a tautology: the handler span runs strictly inside
 *   the request k6 times, so each request's client duration bounds its server duration, and a p95
 *   over the same requests inherits the bound. A mis-bucketed clock, a wrong duration column or a
 *   unit mix-up breaks it.
 *
 * Run: `deno run -A tests/e2e/observability_test.ts` (needs `k6` on `PATH`; ~45 s).
 *
 * Negative control: `OBS_SINK=noop deno run -A tests/e2e/observability_test.ts` must fail. It starts
 * the server (and its reader) with `LOG_LEVEL=error`, so `EventSinkLive`'s level gate drops every
 * record below `error` before it is queued — on a clean run, every record either process emits (the
 * test prints the server-log record count to show it). No handler events reach the JSONL, ingest has
 * none to load, and the join returns no rows. It is a config setting rather than a substituted
 * `EventSink`: the server's composition has no sink seam, and a module-level switch in
 * `platform/logging/logger.ts` would break the rule that only `platform/config.ts` reads the
 * environment (`tests/unit/server_scope_test.ts`).
 *
 * Not covered here: `deno task logs:query k6-vs-platform` is item 23's CLI over its catalog; this
 * file verifies the data and the join underneath it.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Effect, Exit } from "effect";
import {
  adminPost,
  awaitTraceIdsInLog,
  duckdbRows,
  scratchRoot,
  serverLogRecords,
  sqlString,
  startScratchServer,
} from "../integration.ts";

const BUCKET = "INTERVAL 10 seconds";

/** The k6-vs-platform join, run on a connection to the k6 file with the event log attached as `events`. */
export function k6VsPlatformSql(runId: string): string {
  const run = sqlString(runId);
  return `WITH client AS (
  SELECT time_bucket(${BUCKET}, ts) AS bucket, scenario,
         count(*) AS client_n, quantile_cont(value, 0.95) AS client_p95_ms
  FROM k6_points
  WHERE run_id = ${run} AND metric = 'http_req_duration'
  GROUP BY ALL
), server AS (
  SELECT time_bucket(${BUCKET}, ts) AS bucket,
         count(*) AS server_n, quantile_cont(duration_ms, 0.95) AS server_p95_ms
  FROM events.platform_events
  WHERE event_kind = 'handler' AND role = 'server' AND ends_with(trace_id, '-' || ${run})
  GROUP BY ALL
)
SELECT strftime(coalesce(client.bucket, server.bucket), '%H:%M:%S') AS bucket, scenario,
       client_n, client_p95_ms, server_n, server_p95_ms
FROM client FULL OUTER JOIN server USING (bucket)
ORDER BY coalesce(client.bucket, server.bucket)`;
}

const program = Effect.gen(function* () {
  const runId = `e2e-obs-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-` +
    crypto.randomUUID().slice(0, 6);
  const k6Dir = resolve("logs", "k6", runId);
  yield* Effect.acquireRelease(
    Effect.promise(() => Deno.mkdir(k6Dir, { recursive: true })),
    (_, exit) =>
      Exit.isSuccess(exit)
        ? Effect.promise(() => Deno.remove(k6Dir, { recursive: true }))
        : Effect.sync(() => console.error(`k6 artifacts kept for diagnosis: ${k6Dir}`)),
  );
  const root = yield* scratchRoot("document-db-e2e-obs-");
  const noop = Deno.env.get("OBS_SINK") === "noop";
  const sink = noop
    ? "EventSinkLive gated to drop everything (OBS_SINK=noop: LOG_LEVEL=error)"
    : "EventSinkLive";
  console.log(`run_id=${runId} sink=${sink}`);

  // --- server up: k6, then ingest ------------------------------------------
  const server = yield* Effect.scoped(Effect.gen(function* () {
    const server = yield* startScratchServer(root, noop ? { LOG_LEVEL: "error" } : {});
    const k6 = yield* Effect.promise(() =>
      new Deno.Command("k6", {
        args: ["run", "--quiet", "--out", `json=${resolve(k6Dir, "raw.json")}`, "perf/smoke.js"],
        env: { BASE_URL: server.base, APP_ID: "tic-tac-toe", TOKEN: "dev-only", K6_RUN_ID: runId },
        stdout: "piped",
        stderr: "piped",
      }).output()
    );
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    // k6's thresholds are what notice a down or failing server.
    assert.equal(k6.code, 0, `k6 failed:\n${decode(k6.stdout)}\n${decode(k6.stderr)}`);
    const summary = JSON.parse(decode(k6.stdout)) as { http_req_duration_p95?: number };
    console.log(`k6: exit 0, overall http_req_duration p95 ${summary.http_req_duration_p95?.toFixed(3)} ms`);

    // Flush barrier: once a request made after k6 finished is in the log, every k6 request's records
    // are too (one FIFO queue). Best effort — the assertions below are on what ingest finds.
    const barrier = `e2e-barrier-${runId}`;
    yield* Effect.promise(async () =>
      (await fetch(`${server.base}/health`, { headers: { "x-trace-id": barrier } })).body?.cancel()
    );
    const missing = yield* awaitTraceIdsInLog(server.logDir, [barrier]);
    if (missing.length > 0) console.log(`barrier trace ${barrier} never reached the server log`);

    const ingest = yield* adminPost(server.base, "/admin/logs/ingest");
    assert.equal(ingest.status, 200, JSON.stringify(ingest.body));
    console.log(`logs ingest: ${JSON.stringify(ingest.body.result)}`);
    const stopped = yield* server.stop;
    assert.equal(stopped.code, 0, "SIGTERM must stop the server cleanly");
    const written = yield* Effect.promise(() => serverLogRecords(server.logDir));
    console.log(`server JSONL: ${written.length} records after shutdown`);
    return server;
  }));

  // --- server down: k6 ingest, then the join ---------------------------------
  const k6Ingest = yield* Effect.promise(() =>
    new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "perf/ingest_k6.ts"],
      env: { K6_RUN_ID: runId },
      stdout: "piped",
      stderr: "piped",
    }).output()
  );
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  assert.ok(k6Ingest.success, `perf/ingest_k6.ts failed: ${decode(k6Ingest.stderr)}`);
  console.log(decode(k6Ingest.stdout).trim());

  const k6Db = resolve(k6Dir, "k6.duckdb");
  const [counts] = yield* duckdbRows(
    k6Db,
    `SELECT (SELECT count(*) FROM k6_points WHERE run_id = ${sqlString(runId)}
               AND metric = 'http_req_duration') AS client_requests,
            (SELECT count(*) FROM events.platform_events WHERE event_kind = 'handler' AND role = 'server'
               AND ends_with(trace_id, '-' || ${sqlString(runId)})) AS server_handler_events,
            (SELECT count(*) FROM events.platform_events) AS platform_events_total`,
    server.eventLogPath,
  );
  console.log(`rows: ${JSON.stringify(counts)}`);

  const rows = yield* duckdbRows(k6Db, k6VsPlatformSql(runId), server.eventLogPath);
  console.table(rows);
  // The full outer join is for the diagnosis; the k6-vs-platform result is its matched rows.
  const joined = rows.filter((row) => row.client_n !== null && row.server_n !== null);
  assert.ok(joined.length > 0, "k6-vs-platform join returned no rows (no bucket has server handler events)");
  const unmatched = rows.filter((row) => !joined.includes(row));
  assert.deepEqual(unmatched, [], "every 10-second bucket must have both client and server samples");
  const inverted = joined.filter((row) => Number(row.client_p95_ms) < Number(row.server_p95_ms));
  assert.deepEqual(inverted, [], "client p95 must be >= server handler p95 in every bucket");

  console.log(
    `PASS: k6 smoke exit 0, k6_points loaded, logs ingest populated platform_events, ` +
      `k6-vs-platform join: ${joined.length} buckets, client p95 >= server p95 in each ` +
      `(logs:query CLI PENDING item 23)`,
  );
});

if (import.meta.main) {
  await Effect.runPromise(Effect.scoped(program));
}
