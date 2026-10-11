-- recent-errors.sql
--
-- Question: what are the most recent errors, with their detail/attrs, newest first?
-- Table: platform_events (schema v2).
-- Variables: $limit (row cap, e.g. 100).
--
-- `attrs` is the record's kind-specific JSON payload (including `errorDetail`).

SELECT
  ts,
  trace_id,
  role,
  app_id,
  event_kind,
  handler_kind,
  name,
  error_tag,
  attrs
FROM platform_events
WHERE outcome = 'error'
ORDER BY ts DESC
LIMIT $limit;
