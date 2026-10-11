-- backup-durations.sql
--
-- Question: per-app backup phases, durations, bytes, failures, and the gap between successive
-- successful backups — mirrors the plan's named `backup-history` query (§4.3, item 23).
-- Table: backup_events.
-- Variables (optional; unset = unbounded): start_ts, end_ts — TIMESTAMP, half-open.
--
-- One successful run emits eight rows, in order: snapshot, verify, hash, put-object (the .sqlite),
-- put-object (its .sqlite.json manifest), put-manifest, put-object (latest.json), publish-latest.
-- put-object rows come from ObjectStore (one per PUT), the rest from platform/backup.ts, so
-- put-object is split here by what was written (`object`). `bytes` is set on hash (snapshot size)
-- and put-object only. A run "succeeds" when publish-latest lands with outcome 'ok'; the gap is
-- measured between those rows. backup_events has no trace_id, but platform_events does (one per
-- run), so `platform_events WHERE kind = 'backup'` groups phases into runs if you need that.

WITH windowed AS (
  SELECT
    *,
    CASE
      WHEN phase <> 'put-object' THEN NULL
      WHEN key LIKE '%/latest.json' THEN 'latest'
      WHEN key LIKE '%.sqlite.json' THEN 'manifest'
      WHEN key LIKE '%.sqlite' THEN 'snapshot'
      ELSE 'other'
    END AS object
  FROM backup_events
  WHERE ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
    AND ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
),
per_phase AS (
  SELECT
    app_id,
    phase,
    object,
    min(ts) AS first_ts,
    count(*) AS phase_count,
    count(*) FILTER (WHERE outcome <> 'ok') AS failure_count,
    round(avg(duration_ms), 3) AS avg_duration_ms,
    round(max(duration_ms), 3) AS max_duration_ms,
    sum(bytes) AS total_bytes
  FROM windowed
  GROUP BY app_id, phase, object
),
successes AS (
  SELECT
    app_id,
    ts - lag(ts) OVER (PARTITION BY app_id ORDER BY ts) AS gap_since_prior_success
  FROM windowed
  WHERE phase = 'publish-latest'
    AND outcome = 'ok'
),
gaps AS (
  SELECT
    app_id,
    count(*) AS successful_runs,
    round(avg(epoch(gap_since_prior_success)), 3) AS avg_gap_between_successes_sec
  FROM successes
  GROUP BY app_id
)
SELECT
  p.app_id,
  p.phase,
  p.object,
  p.phase_count,
  p.failure_count,
  p.avg_duration_ms,
  p.max_duration_ms,
  p.total_bytes,
  g.successful_runs,
  g.avg_gap_between_successes_sec
FROM per_phase p
LEFT JOIN gaps g USING (app_id)
ORDER BY p.app_id, p.first_ts, p.phase, p.object;
