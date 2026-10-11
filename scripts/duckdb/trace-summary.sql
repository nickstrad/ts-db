-- trace-summary.sql
--
-- Question: which traces are the longest or noisiest, so one can be opened with
-- trace-timeline.sql? One row per trace_id: processes involved, wall-clock span, event mix,
-- summed transaction time, and error tags.
-- Table: platform_events.
-- Variables (optional): start_ts, end_ts — TIMESTAMP, half-open (unset = unbounded);
--   row_limit — row cap, default 20.
--
-- `trace_class` separates request traces from ids that are not one request:
-- - `fiber-fallback`: an Effect fiber id (`#2`). The emitter had no `traceId` log annotation, so it
--   fell back to FiberId.threadName (platform/sqlite.ts, platform/logging/logger.ts). Fiber ids
--   restart in every process, so `#2` merges every writer process's sql/tx events into one
--   "trace" — today that is all writer traffic, because nothing annotates a request until item 22.
-- - `process`: per-process or per-run sentinels — reader-lifecycle, event-sink, reader-client-<id>,
--   ingest-<run id>.
-- - `request`: everything else; today the reader's `reader-<pid>-<frame id>` and one id per
--   backup run.

SELECT
  trace_id,
  CASE
    WHEN trace_id LIKE '#%' THEN 'fiber-fallback'
    WHEN trace_id IN ('reader-lifecycle', 'event-sink')
      OR trace_id LIKE 'reader-client-%'
      OR trace_id LIKE 'ingest-%' THEN 'process'
    ELSE 'request'
  END AS trace_class,
  string_agg(DISTINCT role, ',' ORDER BY role) AS roles,
  min(ts) AS first_ts,
  max(ts) - min(ts) AS wall_span,
  count(*) AS events,
  count(*) FILTER (WHERE kind = 'sql') AS sql_events,
  count(*) FILTER (WHERE kind = 'tx') AS tx_events,
  round(sum(duration_ms) FILTER (WHERE kind = 'tx'), 3) AS tx_ms,
  string_agg(DISTINCT error_tag, ',' ORDER BY error_tag) AS error_tags
FROM platform_events
WHERE ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
  AND ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
GROUP BY trace_id
ORDER BY wall_span DESC, events DESC
LIMIT coalesce(getvariable('row_limit')::INTEGER, 20);
