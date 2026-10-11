-- tx-outcomes.sql
--
-- Question: commit/rollback/interrupted counts per process, engine and app, with the error-tag
-- mix and the transaction and writer-queue wait times — the plan's named `tx-outcomes` query
-- (§4.3, item 23).
-- Table: tx_events (engine sqlite = writer mutations, duckdb = reader query transactions).
-- Variables (optional; unset = unbounded): start_ts, end_ts — TIMESTAMP, half-open.
--
-- queue_wait_ms is the admission-to-start wait: the writer queue (sqlite) or the reader's
-- per-app open/BEGIN path (duckdb).
-- A rollback with an error_tag is a handler failure (rule, conflict, not-found, schema), not a
-- storage fault — compare with error-breakdown.sql.

SELECT
  engine,
  app_id,
  outcome,
  error_tag,
  count(*) AS tx_count,
  round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY engine, app_id), 2) AS pct_of_app_engine,
  round(quantile_cont(duration_ms, 0.50), 3) AS p50_ms,
  round(quantile_cont(duration_ms, 0.95), 3) AS p95_ms,
  round(max(duration_ms), 3) AS max_ms,
  round(quantile_cont(queue_wait_ms, 0.95), 3) AS p95_queue_wait_ms,
  round(max(queue_wait_ms), 3) AS max_queue_wait_ms,
  round(avg(operations), 2) AS avg_operations
FROM tx_events
WHERE ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
  AND ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
GROUP BY engine, app_id, outcome, error_tag
ORDER BY engine, app_id, tx_count DESC;
