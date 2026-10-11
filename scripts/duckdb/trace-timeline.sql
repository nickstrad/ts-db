-- trace-timeline.sql
--
-- Question: the complete ordered event timeline for one trace_id — mirrors the plan's named
-- `trace` analysis query (§4.3, item 23).
-- Tables: platform_events (backbone), sql_events (for sql_text), k6_points.
-- Variables: trace_id (required). trace-summary.sql lists candidate trace ids.
--
-- Every ingested record is in platform_events, including the ones also copied to a typed table,
-- so the timeline reads platform_events alone and only borrows sql_text from sql_events. (Unioning
-- the typed tables in as well would list every sql/tx/http event twice.) The typed tables carry no
-- event_id, so the sql_text join is on (trace_id, ts, statement_kind, duration_ms); k6_points is
-- filled by perf:ingest, not the event-log ingest, so it is unioned.
--
-- Cross-process caveat: the reader stamps its own trace ids (`reader-<pid>-<frame id>`,
-- platform/reader.ts) because ReaderRequestFrame carries no trace id, so a server request's trace
-- does not yet include the reader-side sql/tx of the queries it made.

WITH platform AS (
  SELECT
    p.ts,
    p.source_file,
    p.source_offset,
    p.role,
    p.pid,
    p.span_id,
    p.kind,
    p.name,
    p.outcome,
    p.error_tag,
    p.duration_ms,
    coalesce(s.sql_text, p.attrs::VARCHAR) AS detail
  FROM platform_events p
  LEFT JOIN sql_events s
    ON p.kind = 'sql'
   AND s.trace_id = p.trace_id
   AND s.ts = p.ts
   AND s.statement_kind = p.name
   AND s.duration_ms IS NOT DISTINCT FROM p.duration_ms
  WHERE p.trace_id = getvariable('trace_id')
)
SELECT ts, role, pid, span_id, kind, name, outcome, error_tag, duration_ms, detail
FROM (
  SELECT *, 0 AS source_rank FROM platform

  UNION ALL

  SELECT
    ts,
    NULL AS source_file,
    NULL AS source_offset,
    'k6' AS role,
    NULL AS pid,
    NULL AS span_id,
    metric AS kind,
    scenario AS name,
    status AS outcome,
    NULL AS error_tag,
    value AS duration_ms,
    tags::VARCHAR AS detail,
    1 AS source_rank
  FROM k6_points
  WHERE trace_id = getvariable('trace_id')
)
ORDER BY ts, source_rank, source_file, source_offset;
