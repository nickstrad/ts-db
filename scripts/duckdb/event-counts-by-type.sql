-- event-counts-by-type.sql
--
-- Question: how many events of each kind/name landed in a time window?
-- Table: platform_events (landed item 21; core/eventlog/ddl.ts).
-- Variables: getvariable('start_ts'), getvariable('end_ts') (UTC TIMESTAMP bounds: start inclusive, end exclusive).
--
-- Mapping: platform_events.kind is the event discriminant except handler events,
-- which map to query/mutation. Normalize those for event-type counts, preserving
-- the routed handler kind separately. name follows platform/eventlog/tables.ts.

SELECT
  CASE WHEN kind IN ('query', 'mutation') THEN 'handler' ELSE kind END AS event_kind,
  CASE WHEN kind IN ('query', 'mutation') THEN kind END AS handler_kind,
  name,
  outcome,
  count(*) AS event_count
FROM platform_events
WHERE ts >= getvariable('start_ts')
  AND ts <  getvariable('end_ts')
GROUP BY event_kind, handler_kind, name, outcome
ORDER BY event_count DESC;
