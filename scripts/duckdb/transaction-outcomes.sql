-- Real reader/writer transactions use commit/rollback/interrupted, not ok/error.
-- Variables: start_ts, end_ts; UTC [start, end).
SELECT
  engine, app_id, outcome, error_tag, count(*) AS tx_count,
  round(quantile_cont(duration_ms, 0.95), 3) AS p95_ms,
  round(quantile_cont(queue_wait_ms, 0.95), 3) AS p95_queue_wait_ms
FROM tx_events
WHERE ts >= getvariable('start_ts') AND ts < getvariable('end_ts')
GROUP BY engine, app_id, outcome, error_tag
ORDER BY tx_count DESC, engine, app_id, outcome;
