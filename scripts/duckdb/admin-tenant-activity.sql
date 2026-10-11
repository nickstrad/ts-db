-- Tenant/key admin HTTP activity. This is NOT tenant-scoped application analysis:
-- schema v2 lacks trusted tenant attribution. Do not infer it from caller trace ids.
-- $start_ts is inclusive; $end_ts is exclusive.
SELECT name AS operation, status, error_tag, count(*) AS requests,
       round(quantile_cont(duration_ms, 0.95), 3) AS p95_ms
FROM http_events
WHERE starts_with(name, 'admin.tenants.')
  AND ts >= $start_ts AND ts < $end_ts
GROUP BY name, status, error_tag
ORDER BY operation, status, error_tag;
