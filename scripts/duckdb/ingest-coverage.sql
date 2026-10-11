-- Offset progress versus event rows per source. Quarantined lines, duplicates and
-- partial tails prevent inferring line counts from byte offsets. A state row may
-- exist with zero accepted events. This does not compare current filesystem size.
SELECT
  s.source_file, s.bytes_ingested, s.last_ingested_at, s.dedupe,
  count(p.event_id) AS event_count,
  min(p.ts) AS first_event_ts, max(p.ts) AS last_event_ts
FROM _ingest_state s
LEFT JOIN platform_events p ON p.source_file = s.source_file
GROUP BY s.source_file, s.bytes_ingested, s.last_ingested_at, s.dedupe
ORDER BY s.source_file;
