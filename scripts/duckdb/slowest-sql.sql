-- slowest-sql.sql
--
-- Question: p50/p95/p99 duration_ms by engine, statement kind and table — mirrors the
-- plan's named `slowest-sql` analysis query (§4.3, item 23).
-- Table: sql_events (landed item 21; core/eventlog/ddl.ts).
-- Variables: getvariable('start_ts'), getvariable('end_ts') (UTC TIMESTAMP bounds: start inclusive, end exclusive).

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
WHERE ts >= getvariable('start_ts')
  AND ts <  getvariable('end_ts')
  AND outcome = 'ok'
GROUP BY engine, statement_kind, table_name
ORDER BY p95_ms DESC;
