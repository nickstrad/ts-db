-- recent-errors.sql
--
-- Question: what are the most recent errors, with their detail/attrs, newest first?
-- Table: platform_events (PLANNED SCHEMA — items 21-23 not yet landed).
-- Variables: $limit (row cap, e.g. 100).
--
-- Assumption: `attrs` is the generic JSON payload column from §4.1. core/events.ts notes
-- EventRecord has no `attrs` field today — it carries error payloads in `errorDetail` —
-- and that item 11 should map `errorDetail` -> `attrs` when it populates this table.

SELECT
  ts,
  trace_id,
  role,
  app_id,
  kind,
  name,
  error_tag,
  attrs
FROM platform_events
WHERE outcome = 'error'
ORDER BY ts DESC
LIMIT $limit;
