-- log-level-distribution.sql
--
-- Question: what's the distribution of log levels (debug/info/warn/error) in the
-- rotated JSONL event log right now?
-- Source: the JSONL files themselves — no DuckDB table or ingest needed. This is the
-- one query in this folder that works against real files today (see README).
-- Field names are the camelCase envelope fields from core/events.ts (`toJsonLine`),
-- NOT the snake_case DuckDB column names used by the other queries here.
-- Variables: $log_glob — a glob matching one or more rotated JSONL files, e.g.
--   'logs/server/2026-10-10/events-*.jsonl'. Widen it (e.g. 'logs/*/*/events-*.jsonl')
--   to cover every role and date.

SELECT
  level,
  count(*) AS event_count,
  round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct_of_total
FROM read_json($log_glob, format = 'newline_delimited')
GROUP BY level
ORDER BY event_count DESC;
