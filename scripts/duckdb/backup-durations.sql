-- backup-durations.sql
--
-- Question: per-app backup phases, durations, bytes, failures, and the gap between
-- successive successful backups.
-- Table: backup_events (schema v2).
-- Variables: $start_ts, $end_ts (inclusive TIMESTAMP bounds).
--
-- Assumption: a backup "succeeds" when its final phase, `publish-latest`, lands with
-- outcome = 'ok' (core/errors.ts's BackupPhase order: snapshot, verify, hash,
-- put-object, put-manifest, publish-latest). Only `emitter = 'backups'` rows are phases;
-- `emitter = 'object-store'` rows are per-PUT transfers and are left out. backup_events
-- carries no trace_id (it has `run_id`, which this query does not need), so it reports
-- per-phase stats and treats successful `publish-latest` rows as the "backup completed"
-- marker for the gap calculation.

WITH windowed AS (
  SELECT *
  FROM backup_events
  WHERE emitter = 'backups'
    AND ts >= $start_ts
    AND ts <  $end_ts
),
per_phase AS (
  SELECT
    app_id,
    phase,
    count(*) AS phase_count,
    count(*) FILTER (WHERE outcome = 'error') AS failure_count,
    round(avg(duration_ms), 3) AS avg_duration_ms,
    round(max(duration_ms), 3) AS max_duration_ms,
    sum(bytes) AS total_bytes
  FROM windowed
  GROUP BY app_id, phase
),
successes AS (
  SELECT
    app_id,
    ts,
    ts - lag(ts) OVER (PARTITION BY app_id ORDER BY ts) AS gap_since_prior_success
  FROM windowed
  WHERE phase = 'publish-latest'
    AND outcome = 'ok'
)
SELECT
  p.app_id,
  p.phase,
  p.phase_count,
  p.failure_count,
  p.avg_duration_ms,
  p.max_duration_ms,
  p.total_bytes,
  (SELECT round(avg(epoch(gap_since_prior_success)), 1)
     FROM successes s WHERE s.app_id = p.app_id) AS avg_gap_between_successes_sec
FROM per_phase p
ORDER BY p.app_id, p.phase;
