-- error-breakdown.sql
--
-- Question: which error_tag values are showing up, how often, and what share of all
-- errors (and of all events) do they represent in the window?
-- Table: platform_events (PLANNED SCHEMA — items 21-23 not yet landed).
-- Variables: $start_ts, $end_ts (inclusive TIMESTAMP bounds).

WITH windowed AS (
  SELECT *
  FROM platform_events
  WHERE ts >= $start_ts
    AND ts <  $end_ts
),
totals AS (
  SELECT
    count(*) AS total_events,
    count(*) FILTER (WHERE outcome = 'error') AS total_errors
  FROM windowed
)
SELECT
  w.error_tag,
  count(*) AS error_count,
  round(100.0 * count(*) / t.total_errors, 2) AS pct_of_errors,
  round(100.0 * count(*) / t.total_events, 2) AS pct_of_all_events
FROM windowed w, totals t
WHERE w.outcome = 'error'
GROUP BY w.error_tag, t.total_errors, t.total_events
ORDER BY error_count DESC;
