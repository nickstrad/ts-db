-- event-counts-by-type.sql
--
-- Question: how many events of each role/kind/name/outcome landed in a time window?
-- Table: platform_events (item 21 ingest; every ingestible record lands here).
-- Variables (optional; unset = unbounded): start_ts, end_ts — TIMESTAMP, half-open
--   [start_ts, end_ts), UTC wall time.
--
-- Column meanings follow platform/eventlog/tables.ts's mapping:
-- - `kind` is the core/events.ts discriminant (http | sql | tx | queue | backup | lifecycle |
--   ingest), EXCEPT handler records, whose kind is their handlerKind (query | mutation).
-- - `name` is the most specific label: statementKind (sql), queue (queue), phase (backup,
--   lifecycle — `log` for Effect.log* lines), sourceFile (ingest), name (http, handler).
-- - `outcome` is ok | error (sql, backup), commit | rollback | interrupted (tx), the queue
--   event (queue), status (ingest), NULL (lifecycle).

SELECT
  role,
  kind,
  name,
  outcome,
  count(*) AS event_count
FROM platform_events
WHERE ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
  AND ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
GROUP BY role, kind, name, outcome
ORDER BY event_count DESC, role, kind, name;
