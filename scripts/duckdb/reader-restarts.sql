-- Reader supervision attempts and recoveries, from actual server lifecycle events.
-- $start_ts is inclusive; $end_ts is exclusive. Admin-global, not tenant-scoped.
SELECT ts, pid AS server_pid, phase,
       try_cast(detail ->> 'attempt' AS INTEGER) AS attempt,
       try_cast(detail ->> 'backoffMs' AS INTEGER) AS backoff_ms,
       try_cast(detail ->> 'pid' AS INTEGER) AS replacement_pid,
       try_cast(detail ->> 'code' AS INTEGER) AS exit_code,
       detail ->> 'signal' AS signal,
       try_cast(detail ->> 'attempts' AS INTEGER) AS abandoned_attempts
FROM lifecycle_events
WHERE role = 'server'
  AND phase IN ('reader-restarting', 'reader-restarted', 'reader-restart-abandoned')
  AND ts >= $start_ts AND ts < $end_ts
ORDER BY ts, server_pid;
