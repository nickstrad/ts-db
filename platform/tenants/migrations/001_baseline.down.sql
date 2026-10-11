-- Down migration for 001_baseline: drops the MT-01 tenant-registry tables.
--
-- The runner's down-safety check refuses to run this while tenants/api_keys hold rows,
-- so this never silently discards live data. schema_migrations (the runner's journal)
-- is intentionally left in place.
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS tenants;
