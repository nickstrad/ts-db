-- ingest-health.sql
--
-- Question: is the event-log ingest keeping up and clean? Per JSONL source file: bytes and rows
-- ingested, when it last moved, whether it was ever rewritten (dedupe), and how many lines were
-- quarantined. Covers item 21's exactly-once ingest.
-- Tables: _ingest_state (one row per source file), platform_events (ingested rows, and the
--   `ingest` anomaly events the ingest itself emits).
-- Variables: none.
--
-- Ingest emits an event only for anomalies (rejected lines, a rewritten source, an unreadable
-- file, a failed run) — platform/eventlog/ingest.ts. `rejected_lines` sums attrs.rejected from
-- RejectedLines events; the lines themselves are in LOG_DIR/<role>/<date>/rejected.jsonl. A
-- file present on disk but missing here has never been ingested: compare with the log tree.

WITH rows_per_file AS (
  SELECT source_file, count(*) AS rows_ingested, max(ts) AS newest_event_ts
  FROM platform_events
  GROUP BY source_file
),
anomalies AS (
  SELECT
    name AS source_file,
    count(*) AS anomaly_events,
    string_agg(DISTINCT error_tag, ', ' ORDER BY error_tag) AS anomaly_tags,
    sum(TRY_CAST(attrs ->> '$.rejected' AS BIGINT)) AS rejected_lines,
    max(ts) AS last_anomaly_ts
  FROM platform_events
  WHERE kind = 'ingest'
  GROUP BY name
)
SELECT
  s.source_file,
  s.bytes_ingested,
  r.rows_ingested,
  coalesce(a.rejected_lines, 0) AS rejected_lines,
  s.dedupe AS rewritten,
  s.last_ingested_at,
  r.newest_event_ts,
  a.anomaly_tags,
  a.last_anomaly_ts
FROM _ingest_state s
LEFT JOIN rows_per_file r USING (source_file)
LEFT JOIN anomalies a USING (source_file)
ORDER BY s.source_file;
