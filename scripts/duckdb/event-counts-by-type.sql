-- event-counts-by-type.sql
--
-- Question: how many events of each kind/name landed in a time window?
-- Table: platform_events (schema v2, core/eventlog/ddl.ts).
-- Variables: $start_ts, $end_ts (inclusive start, exclusive end TIMESTAMP bounds).
--
-- `event_kind` is the record's kind (http | handler | sql | tx | queue | backup | lifecycle |
-- ingest); `handler_kind` is the routed handler's query/mutation, set for handler/http rows;
-- `name` is the handler name where there is one.

SELECT
  event_kind,
  handler_kind,
  name,
  outcome,
  count(*) AS event_count
FROM platform_events
WHERE ts >= $start_ts
  AND ts <  $end_ts
GROUP BY event_kind, handler_kind, name, outcome
ORDER BY event_count DESC;
