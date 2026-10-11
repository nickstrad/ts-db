-- One row per ingested platform event for a trace, including backup/queue/lifecycle.
-- Typed tables project the SAME records: UNIONing them duplicates the timeline.
-- k6_points is excluded: no producer has landed, and metric values are not all ms.
-- Variable: trace_id (SET VARIABLE trace_id = 'reader-...').
-- source_file/source_offset make equal timestamps deterministic. Rewritten files
-- can make those original offsets stale; event_id identifies the ingested event.

SELECT
  ts, event_id, trace_id, role, app_id, kind, name, outcome, error_tag,
  duration_ms, attrs, source_file, source_offset
FROM platform_events
WHERE trace_id = getvariable('trace_id')
ORDER BY ts, source_file, source_offset, event_id;
