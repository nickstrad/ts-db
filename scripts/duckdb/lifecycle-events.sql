-- lifecycle-events.sql
--
-- Question: startup/shutdown (and other) phases per role/pid, in order, with the time
-- spent between consecutive phases of the same process.
-- Table: lifecycle_events (schema v2).
-- Variables: $start_ts, $end_ts (inclusive TIMESTAMP bounds).
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
WHERE ts >= $start_ts
  AND ts <  $end_ts
ORDER BY role, pid, ts;
