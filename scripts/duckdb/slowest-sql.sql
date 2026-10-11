-- slowest-sql.sql
--
-- Question: p50/p95/p99 duration_ms by engine, statement kind and table — mirrors the plan's
-- named `slowest-sql` analysis query (§4.3, item 23).
-- Table: sql_events (only populated when TRACE_SQL is on: one row per compiled statement;
--   engine sqlite = writer, duckdb = reader).
-- Variables (optional; unset = unbounded): start_ts, end_ts — TIMESTAMP, half-open.
--
-- table_name is NULL for statements that name no single table (pragma, most ddl).

SELECT
  engine,
  statement_kind,
  table_name,
  count(*) AS call_count,
  round(quantile_cont(duration_ms, 0.50), 3) AS p50_ms,
  round(quantile_cont(duration_ms, 0.95), 3) AS p95_ms,
  round(quantile_cont(duration_ms, 0.99), 3) AS p99_ms,
  round(max(duration_ms), 3) AS max_ms
FROM sql_events
WHERE ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
  AND ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
  AND outcome = 'ok'
GROUP BY engine, statement_kind, table_name
ORDER BY p95_ms DESC, call_count DESC;
