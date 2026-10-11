-- mutation-vs-query-latency.sql
--
-- Question: writer-path vs reader-path transaction latency over time — the plan's named
-- `mutation-vs-query-latency` query (§4.3, item 23), per time bucket.
-- Table: tx_events. Until item 22 ports the server, nothing emits http or handler events, so the
--   transaction is the closest measure of a request: engine sqlite = mutation (writer),
--   duckdb = query (reader process). Switch to http_events by `kind` once it is populated.
-- Variables (optional): start_ts, end_ts — TIMESTAMP, half-open (unset = unbounded);
--   bucket — an INTERVAL string, default '1 minute'.

SELECT
  time_bucket(coalesce(getvariable('bucket')::INTERVAL, INTERVAL '1 minute'), ts) AS bucket_start,
  CASE engine WHEN 'sqlite' THEN 'mutation' WHEN 'duckdb' THEN 'query' ELSE engine END AS path,
  count(*) AS tx_count,
  count(*) FILTER (WHERE outcome <> 'commit') AS not_committed,
  round(quantile_cont(duration_ms, 0.50), 3) AS p50_ms,
  round(quantile_cont(duration_ms, 0.95), 3) AS p95_ms,
  round(quantile_cont(duration_ms, 0.99), 3) AS p99_ms,
  round(quantile_cont(queue_wait_ms, 0.95), 3) AS p95_queue_wait_ms
FROM tx_events
WHERE ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
  AND ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
GROUP BY ALL
ORDER BY bucket_start, path;
