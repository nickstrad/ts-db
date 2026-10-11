-- Failure records by error tag. A failed operation may emit several records.
-- Table: platform_events (landed item 21; core/eventlog/ddl.ts).
-- Variables: start_ts, end_ts; UTC [start, end).
WITH windowed AS (
  SELECT *,
    (outcome IN ('error', 'rollback', 'interrupted')
      OR error_tag IS NOT NULL OR level = 'error') AS is_failure
  FROM platform_events
  WHERE ts >= getvariable('start_ts') AND ts < getvariable('end_ts')
),
totals AS (
  SELECT count(*) AS total_events,
    count(*) FILTER (WHERE is_failure) AS total_errors
  FROM windowed
)
SELECT
  w.error_tag,
  count(*) AS error_count,
  round(100.0 * count(*) / t.total_errors, 2) AS pct_of_errors,
  round(100.0 * count(*) / t.total_events, 2) AS pct_of_all_events
FROM windowed w, totals t
WHERE w.is_failure
GROUP BY w.error_tag, t.total_errors, t.total_events
ORDER BY error_count DESC, w.error_tag;
