-- error-breakdown.sql
--
-- Question: which error tags are showing up, where (role/kind/app), how often, and what share of
-- all errors (and of all events) do they represent in the window?
-- Table: platform_events.
-- Variables (optional; unset = unbounded): start_ts, end_ts — TIMESTAMP, half-open.
--
-- An event is an error iff `error_tag IS NOT NULL`. `outcome = 'error'` is NOT the test: a failed
-- transaction is `outcome = 'rollback'` with its error_tag set (RuleError, ConflictError,
-- NotFoundError, SchemaError, …), and only sql, backup and ingest records use outcome 'error'.

WITH windowed AS (
  SELECT *
  FROM platform_events
  WHERE ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
    AND ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
),
totals AS (
  SELECT
    count(*) AS total_events,
    count(*) FILTER (WHERE error_tag IS NOT NULL) AS total_errors
  FROM windowed
)
SELECT
  w.error_tag,
  w.role,
  w.kind,
  w.outcome,
  w.app_id,
  count(*) AS error_count,
  round(100.0 * count(*) / t.total_errors, 2) AS pct_of_errors,
  round(100.0 * count(*) / t.total_events, 2) AS pct_of_all_events
FROM windowed w, totals t
WHERE w.error_tag IS NOT NULL
GROUP BY w.error_tag, w.role, w.kind, w.outcome, w.app_id, t.total_errors, t.total_events
ORDER BY error_count DESC, w.error_tag, w.role, w.app_id;
