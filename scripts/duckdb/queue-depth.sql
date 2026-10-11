-- queue-depth.sql
--
-- Question: queue high-water marks, rejections and dropped events over time, per process — the
-- plan's named `queue-depth` query (§4.3, item 23).
-- Tables: queue_events, joined to platform_events for role/pid.
-- Variables (optional): start_ts, end_ts — TIMESTAMP, half-open (unset = unbounded);
--   bucket — an INTERVAL string, default '1 minute'.
--
-- Queues: `events` (each process's log-sink queue; event `dropped` carries how many records were
-- lost since the last report), `reader` (the server's in-flight RPC calls: `high-water`,
-- `rejected`) and `writer` (the mutation queue: `rejected` only).
-- queue_events has no role, pid or event_id, so role/pid come from the matching platform_events
-- row on (ts, queue, event) — two processes reporting the same queue event in the same
-- millisecond would fan out.

WITH q AS (
  SELECT q.*, p.role, p.pid
  FROM queue_events q
  LEFT JOIN platform_events p
    ON p.kind = 'queue'
   AND p.ts = q.ts
   AND p.name = q.queue
   AND p.outcome = q.event
  WHERE q.ts >= coalesce(getvariable('start_ts')::TIMESTAMP, '-infinity'::TIMESTAMP)
    AND q.ts <  coalesce(getvariable('end_ts')::TIMESTAMP, 'infinity'::TIMESTAMP)
)
SELECT
  time_bucket(coalesce(getvariable('bucket')::INTERVAL, INTERVAL '1 minute'), ts) AS bucket_start,
  role,
  pid,
  queue,
  event,
  count(*) AS reports,
  max(depth) AS max_depth,
  max(cap) AS cap,
  sum(dropped) AS dropped
FROM q
GROUP BY ALL
ORDER BY bucket_start, role, pid, queue, event;
