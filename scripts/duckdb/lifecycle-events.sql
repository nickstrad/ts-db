-- lifecycle-events.sql
--
-- Question: process lifecycle phases (reader ready/stopping, reader-spawned/-exited, reader
-- opened, object-get, …) per role/pid, in order, with the time between consecutive phases.
-- Table: lifecycle_events.
-- Variables (optional; unset = unbounded): start_ts, end_ts — TIMESTAMP, half-open.
--
-- `phase` is free-form text (core/events.ts's LifecyclePayload.phase is `string`), so nothing is
-- assumed about specific names. Effect.log* lines are ingested as lifecycle records with phase
-- `log` (platform/logging/logger.ts) and would drown the real phases, so they are excluded here;
-- recent-errors.sql shows the warn/error ones. A process that died uncleanly shows no closing
-- phase (`stopping`, `reader-exited`).

SELECT
  role,
  pid,
  ts,
  phase,
  detail,
  ts - lag(ts) OVER (PARTITION BY role, pid ORDER BY ts) AS time_since_prior_phase
FROM lifecycle_events
WHERE ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
  AND ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
  AND phase <> 'log'
ORDER BY role, pid, ts;
