/**
 * Reproducible synthetic benchmark for lx-02. Run from the repository root:
 *   deno run -A work-scripts/deno/lx-02-query-bench.ts
 * Optional: --rows 1000000 --repeats 3 --batch-rows 100000
 *
 * It creates a temporary DuckDB file and JSONL fixture under the OS temp directory,
 * populates the planned item-21 tables with deterministic typed rows, benchmarks
 * every starter SQL file and every item-23 catalog query, then removes the scratch dir.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { EVENT_TABLE_DDL, EVENT_TABLES } from "../../core/eventlog/ddl.ts";

type Row = Record<string, unknown>;
type Query = { name: string; sql: string; params: Record<string, string | number> };

const args = Deno.args;
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1] ?? fallback;
};
const rowCounts = arg("--rows", "1000000,12000000").split(",").map(Number);
const repeats = Number(arg("--repeats", "3"));
const batchRows = Number(arg("--batch-rows", "100000"));
if (
  rowCounts.some((n) => !Number.isSafeInteger(n) || n < 1) || !Number.isSafeInteger(repeats) || repeats < 1 ||
  !Number.isSafeInteger(batchRows) || batchRows < 1
) {
  throw new Error(
    "--rows must be comma-separated positive integers; --repeats and --batch-rows must be positive integers",
  );
}

const catalog = (start: string, end: string, trace: string): Query[] => [
  {
    name: "catalog:slowest-sql",
    params: {},
    sql: `SELECT engine, statement_kind, table_name, count(*) AS call_count,
      round(quantile_cont(duration_ms, 0.50), 3) AS p50_ms,
      round(quantile_cont(duration_ms, 0.95), 3) AS p95_ms,
      round(quantile_cont(duration_ms, 0.99), 3) AS p99_ms, round(max(duration_ms), 3) AS max_ms
      FROM sql_events WHERE ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}' AND outcome = 'ok'
      GROUP BY engine, statement_kind, table_name ORDER BY p95_ms DESC`,
  },
  {
    name: "catalog:plan-shapes",
    params: {},
    sql: `SELECT sql_text, count(*) AS call_count, round(avg(duration_ms), 3) AS avg_ms,
      round(quantile_cont(duration_ms, 0.95), 3) AS p95_ms FROM sql_events
      WHERE ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}'
      GROUP BY sql_text ORDER BY call_count DESC`,
  },
  {
    name: "catalog:error-rate-by-handler",
    params: {},
    sql: `SELECT app_id, name AS handler, count(*) AS request_count,
      count(*) FILTER (WHERE outcome = 'error') AS error_count,
      round(100.0 * count(*) FILTER (WHERE outcome = 'error') / count(*), 2) AS error_pct,
      list(DISTINCT error_tag) FILTER (WHERE outcome = 'error') AS error_tags
      FROM platform_events WHERE kind = 'handler' AND ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}'
      GROUP BY app_id, name ORDER BY error_pct DESC`,
  },
  {
    name: "catalog:mutation-vs-query-latency",
    params: {},
    sql: `SELECT date_trunc('hour', ts) AS hour, role AS path,
      round(quantile_cont(duration_ms, 0.50), 3) AS p50_ms,
      round(quantile_cont(duration_ms, 0.95), 3) AS p95_ms,
      round(quantile_cont(duration_ms, 0.99), 3) AS p99_ms
      FROM platform_events WHERE ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}'
      GROUP BY hour, path ORDER BY hour, path`,
  },
  {
    name: "catalog:handler-throughput",
    params: {},
    sql: `SELECT date_trunc('minute', ts) AS minute, app_id, name AS handler, outcome,
      count(*) AS request_count FROM platform_events WHERE kind = 'handler'
      AND ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}'
      GROUP BY minute, app_id, handler, outcome ORDER BY minute, app_id, handler`,
  },
  {
    name: "catalog:queue-depth",
    params: {},
    sql: `SELECT date_trunc('minute', ts) AS minute, queue,
      max(depth) FILTER (WHERE event = 'high-water') AS high_water,
      count(*) FILTER (WHERE event = 'rejected') AS rejections,
      sum(dropped) AS dropped FROM queue_events WHERE ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}'
      GROUP BY minute, queue ORDER BY minute, queue`,
  },
  {
    name: "catalog:tx-outcomes",
    params: {},
    sql: `SELECT date_trunc('hour', ts) AS hour, engine, outcome, count(*) AS tx_count,
      round(avg(queue_wait_ms), 3) AS avg_queue_wait_ms,
      round(quantile_cont(queue_wait_ms, 0.95), 3) AS p95_queue_wait_ms
      FROM tx_events WHERE ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}'
      GROUP BY hour, engine, outcome ORDER BY hour, engine, outcome`,
  },
  {
    name: "catalog:backup-history",
    params: {},
    sql:
      `WITH windowed AS (SELECT * FROM backup_events WHERE ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}'),
      phases AS (SELECT app_id, phase, count(*) AS phase_count,
        count(*) FILTER (WHERE outcome = 'error') AS failures,
        round(avg(duration_ms), 3) AS avg_duration_ms, sum(bytes) AS total_bytes
        FROM windowed GROUP BY app_id, phase),
      successes AS (SELECT app_id, ts, ts - lag(ts) OVER (PARTITION BY app_id ORDER BY ts) AS gap
        FROM windowed WHERE phase = 'publish-latest' AND outcome = 'ok')
      SELECT p.*, (SELECT round(avg(epoch(gap)), 1) FROM successes s WHERE s.app_id = p.app_id) AS avg_gap_sec
      FROM phases p ORDER BY app_id, phase`,
  },
  {
    name: "catalog:trace",
    params: {},
    sql: `SELECT ts, 'platform' AS source, kind, name, outcome, error_tag, duration_ms, NULL AS extra
      FROM platform_events WHERE trace_id = '${trace}'
      UNION ALL SELECT ts, 'sql', statement_kind, table_name, outcome, error_tag, duration_ms, sql_text
      FROM sql_events WHERE trace_id = '${trace}'
      UNION ALL SELECT ts, 'tx', 'tx', outcome, outcome, error_tag, duration_ms, NULL
      FROM tx_events WHERE trace_id = '${trace}'
      UNION ALL SELECT ts, 'http', kind, name, CASE WHEN error_tag IS NULL THEN 'ok' ELSE 'error' END,
        error_tag, duration_ms, path FROM http_events WHERE trace_id = '${trace}'
      UNION ALL SELECT ts, 'k6', metric, scenario, status, NULL, value, CAST(tags AS VARCHAR)
        FROM k6_points WHERE trace_id = '${trace}' ORDER BY ts`,
  },
  {
    name: "catalog:k6-vs-platform",
    params: {},
    sql: `WITH k AS (SELECT date_bin(INTERVAL '10 seconds', ts, TIMESTAMP '2000-01-01') AS bucket,
      scenario, quantile_cont(value, 0.95) AS client_p95 FROM k6_points
      WHERE metric = 'http_req_duration' AND ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}'
      GROUP BY bucket, scenario),
      p AS (SELECT date_bin(INTERVAL '10 seconds', ts, TIMESTAMP '2000-01-01') AS bucket,
      name, quantile_cont(duration_ms, 0.95) AS handler_p95 FROM platform_events
      WHERE kind = 'handler' AND ts >= TIMESTAMP '${start}' AND ts < TIMESTAMP '${end}'
      GROUP BY bucket, name)
      SELECT k.bucket, k.scenario, k.client_p95, p.name AS handler, p.handler_p95
      FROM k JOIN p USING (bucket) ORDER BY k.bucket, k.scenario, handler`,
  },
];

function substitute(sql: string, params: Record<string, string | number>): string {
  return sql.replace(/\$(start_ts|end_ts|trace_id|limit|log_glob)\b/g, (placeholder) => {
    const value = params[placeholder.slice(1)];
    if (value === undefined) throw new Error(`No value for ${placeholder}`);
    return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
  });
}

const temp = await Deno.makeTempDir({ prefix: "lx-02-duckdb-" });
const database = `${temp}/events.duckdb`;
const jsonPath = `${temp}/events.jsonl`;
const eventDistribution: [string, number][] = [
  ["platform_events", 0.15],
  ["sql_events", 0.35],
  ["tx_events", 0.10],
  ["http_events", 0.15],
  ["queue_events", 0.05],
  ["backup_events", 0.05],
  ["lifecycle_events", 0.05],
  ["k6_points", 0.10],
];
const instance = await DuckDBInstance.create(database, { threads: "1", memory_limit: "1GB" });
const connection = await instance.connect();
const run = async (sql: string) => await connection.run(sql);
const query = async (sql: string): Promise<Row[]> => (await connection.runAndReadAll(sql)).getRowObjects();
const results: { name: string; rows: number; medianMs: number; error?: string }[] = [];
const explainSql = new Map<string, string>();

try {
  await run("SET TimeZone = 'UTC'");
  for (const table of EVENT_TABLES) await run(EVENT_TABLE_DDL[table]);
  for (const totalRows of rowCounts) {
    await run("DROP TABLE IF EXISTS benchmark_scale");
    for (const table of EVENT_TABLES) await run(`DELETE FROM ${table}`);
    let assigned = 0;
    const counts = new Map<string, number>();
    for (let i = 0; i < eventDistribution.length; i++) {
      const [table, weight] = eventDistribution[i];
      const n = i === eventDistribution.length - 1 ? totalRows - assigned : Math.floor(totalRows * weight);
      counts.set(table, n);
      assigned += n;
    }
    const inserts: Record<string, string> = {
      platform_events:
        `INSERT INTO platform_events SELECT 'event-' || i, TIMESTAMP '2026-09-01' + (i % 2592000) * INTERVAL '1 second',
        CASE WHEN i % 100 = 0 THEN 'error' ELSE 'info' END, 'server', (i % 8)::INTEGER,
        'trace-' || (i % 1000), 'span-' || i, NULL, 'app-' || (i % 20),
        CASE WHEN i % 5 = 0 THEN 'handler' ELSE 'http' END, 'handler-' || (i % 40),
        CASE WHEN i % 100 = 0 THEN 'error' ELSE 'ok' END,
        CASE WHEN i % 100 = 0 THEN 'ValidationError' ELSE NULL END,
        (i % 500)::DOUBLE / 10, json_object('sample', i % 16), 'synthetic.jsonl', i::BIGINT
        FROM range({start}, {end}) t(i)`,
      sql_events: `INSERT INTO sql_events SELECT TIMESTAMP '2026-09-01' + (i % 2592000) * INTERVAL '1 second',
        'trace-' || (i % 1000), 'app-' || (i % 20), CASE WHEN i % 2 = 0 THEN 'sqlite' ELSE 'duckdb' END,
        'sqlite', CASE WHEN i % 4 = 0 THEN 'select' ELSE 'insert' END, 'table-' || (i % 30),
        'SELECT * FROM table_' || (i % 1000), (i % 8)::INTEGER, (i % 2000)::DOUBLE / 10,
        (i % 100)::BIGINT, CASE WHEN i % 50 = 0 THEN 'error' ELSE 'ok' END,
        CASE WHEN i % 50 = 0 THEN 'ConstraintError' ELSE NULL END FROM range({start}, {end}) t(i)`,
      tx_events: `INSERT INTO tx_events SELECT TIMESTAMP '2026-09-01' + (i % 2592000) * INTERVAL '1 second',
        'trace-' || (i % 1000), 'app-' || (i % 20), CASE WHEN i % 2 = 0 THEN 'sqlite' ELSE 'duckdb' END,
        CASE WHEN i % 50 = 0 THEN 'rollback' ELSE 'commit' END, (i % 10)::INTEGER,
        (i % 400)::DOUBLE / 10, (i % 100)::DOUBLE / 10,
        CASE WHEN i % 50 = 0 THEN 'ConstraintError' ELSE NULL END FROM range({start}, {end}) t(i)`,
      http_events:
        `INSERT INTO http_events SELECT TIMESTAMP '2026-09-01' + (i % 2592000) * INTERVAL '1 second',
        'trace-' || (i % 1000), 'GET', '/api/' || (i % 40), 'app-' || (i % 20), 'query', 'handler-' || (i % 40),
        CASE WHEN i % 100 = 0 THEN 500 ELSE 200 END, (i % 500)::DOUBLE / 10, 128::BIGINT, 512::BIGINT,
        CASE WHEN i % 100 = 0 THEN 'InternalError' ELSE NULL END FROM range({start}, {end}) t(i)`,
      queue_events:
        `INSERT INTO queue_events SELECT TIMESTAMP '2026-09-01' + (i % 2592000) * INTERVAL '1 second',
        CASE WHEN i % 2 = 0 THEN 'writer' ELSE 'reader' END, (i % 100)::INTEGER, 256,
        CASE WHEN i % 100 = 0 THEN 'rejected' WHEN i % 10 = 0 THEN 'high-water' ELSE 'accepted' END,
        (i % 3)::BIGINT FROM range({start}, {end}) t(i)`,
      backup_events:
        `INSERT INTO backup_events SELECT TIMESTAMP '2026-09-01' + (i % 2592000) * INTERVAL '1 second',
        'app-' || (i % 20), CASE WHEN i % 6 = 0 THEN 'publish-latest' ELSE 'snapshot' END,
        'backups/' || i, (i % 100000)::BIGINT, 'sha-' || i, (i % 10000)::DOUBLE / 10,
        CASE WHEN i % 100 = 0 THEN 'error' ELSE 'ok' END,
        CASE WHEN i % 100 = 0 THEN 'S3Error' ELSE NULL END FROM range({start}, {end}) t(i)`,
      lifecycle_events:
        `INSERT INTO lifecycle_events SELECT TIMESTAMP '2026-09-01' + (i % 2592000) * INTERVAL '1 second',
        CASE WHEN i % 2 = 0 THEN 'server' ELSE 'reader' END, (i % 8)::INTEGER,
        CASE WHEN i % 2 = 0 THEN 'startup' ELSE 'shutdown' END, json_object('sequence', i % 16)
        FROM range({start}, {end}) t(i)`,
      k6_points: `INSERT INTO k6_points SELECT TIMESTAMP '2026-09-01' + (i % 2592000) * INTERVAL '1 second',
        'run-1', CASE WHEN i % 2 = 0 THEN 'http_req_duration' ELSE 'http_req_failed' END,
        (i % 1000)::DOUBLE / 10, 'mixed', CASE WHEN i % 100 = 0 THEN 'error' ELSE 'ok' END,
        'trace-' || (i % 1000), json_object('status', i % 5)
        FROM range({start}, {end}) t(i)`,
    };
    for (const [table, n] of counts) {
      for (let offset = 0; offset < n; offset += batchRows) {
        const end = Math.min(offset + batchRows, n);
        await run(inserts[table].replace("{start}", String(offset)).replace("{end}", String(end)));
      }
    }

    // The sole JSONL reader query gets an equally sized synthetic file. DuckDB's COPY writer
    // avoids building millions of JavaScript objects while preserving newline-delimited JSON.
    await run(
      `COPY (SELECT CASE WHEN i % 100 = 0 THEN 'error' WHEN i % 10 = 0 THEN 'warn' ELSE 'info' END AS level
      FROM range(0, ${totalRows}) t(i)) TO '${jsonPath}' (FORMAT JSON, ARRAY false)`,
    );

    const start = "2026-09-01 00:00:00";
    const end = "2026-10-01 00:00:00";
    const traceId = "trace-7";
    const all: Query[] = [];
    for (
      const file of [
        "backup-durations.sql",
        "error-breakdown.sql",
        "event-counts-by-type.sql",
        "lifecycle-events.sql",
        "log-level-distribution.sql",
        "recent-errors.sql",
        "slowest-sql.sql",
        "trace-timeline.sql",
      ]
    ) {
      const sql = (await Deno.readTextFile(`scripts/duckdb/${file}`)).replace(/^--.*(?:\n|$)/gm, "");
      const params: Record<string, string | number> = file === "log-level-distribution.sql"
        ? { log_glob: jsonPath }
        : file === "recent-errors.sql"
        ? { limit: 100 }
        : file === "trace-timeline.sql"
        ? { trace_id: traceId }
        : { start_ts: start, end_ts: end };
      all.push({ name: `starter:${file}`, sql: substitute(sql, params), params });
    }
    all.push(...catalog(start, end, traceId));

    console.log(
      `\nRows=${totalRows.toLocaleString()} (distributed across ${EVENT_TABLES.length} item-21 tables); repeats=${repeats}`,
    );
    for (const item of all) {
      explainSql.set(item.name, item.sql);
      try {
        await query(item.sql); // one warm-up run is excluded from the reported median
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        results.push({ name: item.name, rows: totalRows, medianMs: NaN, error: message });
        console.log(`${item.name}\t${totalRows}\tERROR: ${message}`);
        continue;
      }
      const times: number[] = [];
      for (let i = 0; i < repeats; i++) {
        const before = performance.now();
        await query(item.sql);
        times.push(performance.now() - before);
      }
      times.sort((a, b) => a - b);
      const medianMs = times[Math.floor(times.length / 2)];
      results.push({ name: item.name, rows: totalRows, medianMs });
      console.log(`${item.name}\t${totalRows}\t${medianMs.toFixed(3)} ms`);
    }
  }

  console.log("\nEXPLAIN plans at the largest scale (top three by median):");
  const largest = Math.max(...rowCounts);
  const top = results.filter((r) => r.rows === largest && !r.error)
    .sort((a, b) => b.medianMs - a.medianMs).slice(0, 3);
  // Recreate queries using the benchmark's same deterministic parameters.
  const start = "2026-09-01 00:00:00";
  const end = "2026-10-01 00:00:00";
  for (const result of top) {
    const sql = explainSql.get(result.name);
    if (!sql) continue;
    console.log(`\n${result.name} (${result.medianMs.toFixed(3)} ms)`);
    const plan = await query(`EXPLAIN ${sql}`);
    console.log(String(plan[0]?.explain_value ?? JSON.stringify(plan)));
  }
  console.log("\nTiming summary (median ms):");
  console.log("query\trows\tmedian_ms");
  for (const r of results) {
    console.log(`${r.name}\t${r.rows}\t${r.error ?? r.medianMs.toFixed(3)}`);
  }
} finally {
  connection.closeSync();
  instance.closeSync();
  await Deno.remove(temp, { recursive: true }).catch(() => undefined);
}
