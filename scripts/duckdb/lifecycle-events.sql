-- lifecycle-events.sql
--
-- Question: startup/shutdown (and other) phases per role/pid, in order, with the time
-- spent between consecutive phases of the same process.
-- Table: lifecycle_events (landed item 21; core/eventlog/ddl.ts).
-- Variables: getvariable('start_ts'), getvariable('end_ts') (UTC TIMESTAMP bounds: start inclusive, end exclusive).
--
-- Assumption: `phase` is free-form text (core/events.ts's LifecyclePayload.phase is
-- `string`, not an enum), so this query does not filter or assume specific phase names
-- like "startup"/"shutdown" — it reports whatever phases were logged, in order.

SELECT
  role,
  pid,
  ts,
  phase,
  detail,
  ts - lag(ts) OVER (PARTITION BY role, pid ORDER BY ts) AS time_since_prior_phase
FROM lifecycle_events
WHERE ts >= getvariable('start_ts')
  AND ts <  getvariable('end_ts')
ORDER BY role, pid, ts;
