-- recent-errors.sql
--
-- Question: what are the most recent errors and warnings, with their detail, newest first?
-- Table: platform_events.
-- Variables (optional): row_limit — row cap, default 100.
--
-- Included: every row with an error_tag (failed sql/tx/backup/ingest; a rolled-back tx carries
-- its tag with outcome 'rollback', not 'error'), plus warn/error-level rows without one — queue
-- drops/rejections and Effect.logWarning/logError lines (kind lifecycle, name `log`).
-- `attrs` is errorDetail, or detail for lifecycle records (platform/eventlog/tables.ts).

SELECT
  ts,
  level,
  role,
  pid,
  trace_id,
  app_id,
  kind,
  name,
  outcome,
  error_tag,
  attrs
FROM platform_events
WHERE error_tag IS NOT NULL
   OR level IN ('warn', 'error')
ORDER BY ts DESC, source_file DESC, source_offset DESC
LIMIT coalesce(getvariable('row_limit')::INTEGER, 100);
