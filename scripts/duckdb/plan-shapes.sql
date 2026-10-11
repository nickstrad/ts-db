-- plan-shapes.sql
--
-- Question: which compiled SQL texts actually run, how often, and how fast — the plan's named
-- `plan-shapes` query (§4.3, item 23). One row per distinct (engine, sql_text); a declared index
-- that helps shows up as a low p95 for its shape, a missing one as a high p95 / row_count ratio.
-- Table: sql_events (TRACE_SQL must be on).
-- Variables (optional): start_ts, end_ts — TIMESTAMP, half-open (unset = unbounded);
--   row_limit — row cap, default 50.
--
-- sql_text is the compiled text with placeholders; bind values are never part of it (they go to
-- the log only with LOG_INCLUDE_BIND_VALUES, and are not ingested).

SELECT
  engine,
  statement_kind,
  table_name,
  count(*) AS call_count,
  round(quantile_cont(duration_ms, 0.50), 3) AS p50_ms,
  round(quantile_cont(duration_ms, 0.95), 3) AS p95_ms,
  round(sum(duration_ms), 3) AS total_ms,
  round(avg(row_count), 2) AS avg_rows,
  max(bind_count) AS bind_count,
  count(*) FILTER (WHERE outcome <> 'ok') AS failures,
  sql_text
FROM sql_events
WHERE ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
  AND ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
GROUP BY engine, statement_kind, table_name, sql_text
ORDER BY total_ms DESC
LIMIT coalesce(getvariable('row_limit')::INTEGER, 50);
