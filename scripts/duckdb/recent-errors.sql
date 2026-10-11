-- recent-errors.sql
--
-- Question: what are the most recent errors, with their detail/attrs, newest first?
-- Table: platform_events (landed item 21; core/eventlog/ddl.ts).
-- Variables: getvariable('row_limit') (row cap, e.g. 100).
--
-- attrs maps errorDetail (or lifecycle.detail) at ingest, not the full event.
-- Include failed/interrupted transactions and error-level logs, whose outcome
-- may be rollback/interrupted/NULL rather than the string error.

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
WHERE outcome IN ('error', 'rollback', 'interrupted')
   OR error_tag IS NOT NULL
   OR level = 'error'
ORDER BY ts DESC, source_file, source_offset
LIMIT getvariable('row_limit');
