-- log-level-distribution.sql
--
-- Question: what's the distribution of log levels (debug/info/warn/error) per role in the
-- rotated JSONL event log — before (or without) ingesting it?
-- Source: the JSONL files themselves via read_json — no event-log database or ingest needed.
-- Field names are the camelCase envelope fields from core/events.ts (`toJsonLine`), NOT the
-- snake_case DuckDB column names used by the other queries here.
-- Variables: log_glob (required) — a glob over rotated JSONL files, e.g.
--   'logs/server/2026-10-10/events-*.jsonl'; widen to 'logs/*/*/events-*.jsonl' for every role
--   and date. Gzipped files (events-*.jsonl.gz, after LOG_GZIP_AFTER_DAYS) need their own glob.
--
-- `columns` pins the two fields read, so heterogeneous records (every kind has its own payload)
-- never trip schema sniffing. `ignore_errors` skips malformed lines (a torn write, say) instead of
-- failing the whole read — ingest quarantines exactly those lines to rejected.jsonl, so the counts
-- here can exceed platform_events' by the rejected count. For the ingested equivalent, group
-- platform_events by role, level.

SELECT
  role,
  level,
  count(*) AS event_count,
  round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY role), 2) AS pct_of_role
FROM read_json(getvariable('log_glob'),
  format = 'newline_delimited',
  columns = {role: 'VARCHAR', level: 'VARCHAR'},
  ignore_errors = true)
GROUP BY role, level
ORDER BY role, event_count DESC;
