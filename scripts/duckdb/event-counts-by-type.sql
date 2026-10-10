-- event-counts-by-type.sql
--
-- Question: how many events of each kind/name landed in a time window?
-- Table: platform_events (PLANNED SCHEMA — items 21-23 not yet landed; see docs/plans/
--   effect-port-and-observability.md §4.1).
-- Variables: $start_ts, $end_ts (inclusive TIMESTAMP bounds).
--
-- Assumption: `kind` here is the event-kind discriminant from core/events.ts
-- (http | handler | sql | tx | queue | backup | lifecycle | ingest), and `name` is the
-- per-kind name field (handler/http name). core/events.ts flags that `platform_events.kind`
-- is overloaded with the routed handler's query/mutation distinction for handler events —
-- item 11/23 need to resolve that collision; this query assumes the discriminant sense.

SELECT
  kind,
  name,
  outcome,
  count(*) AS event_count
FROM platform_events
WHERE ts >= $start_ts
  AND ts <  $end_ts
GROUP BY kind, name, outcome
ORDER BY event_count DESC;
