-- log-level-distribution.sql
--
-- Question: what's the distribution of log levels (debug/info/warn/error) in the
-- rotated JSONL event log right now?
-- Source: the JSONL files themselves — no DuckDB table or ingest needed. This is the
-- query that bypasses ingest (the other queries use the landed event tables).
-- Field names are the camelCase envelope fields from core/events.ts (`toJsonLine`),
-- NOT the snake_case DuckDB column names used by the other queries here.
-- Variables: getvariable('log_glob') — a glob matching one or more rotated JSONL files, e.g.
--   'logs/server/2026-10-10/events-*.jsonl'. Widen it (e.g. 'logs/*/*/events-*.jsonl')
--   to cover every role and date.

SELECT
  level,
  count(*) AS event_count,
  round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct_of_total
FROM read_json(getvariable('log_glob'), format = 'newline_delimited', columns = {level: 'VARCHAR'}, union_by_name = true)
GROUP BY level
ORDER BY event_count DESC;
