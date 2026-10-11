/**
 * DDL for the append-only DuckDB event log (plan item 21, §4.1): the typed event tables and the
 * `_ingest_state` offset table, as pure strings.
 *
 * This module is PURE: no imports at all. `platform/eventlog/tables.ts` runs these statements against
 * the persistent event-log file (`Config.eventLog.duckdbPath`), which is separate from the per-app
 * `:memory:` instances the `Reader` service opens. Every statement is `CREATE TABLE IF NOT EXISTS`, so
 * running the whole list against an existing file is a no-op and never touches a row.
 *
 * Two kinds of table, with different rules:
 *
 * - **Event tables** are append-only. Ingest only ever `INSERT`s into them; nothing in this repo
 *   rewrites or removes an event row. Losing the file loses nothing durable: the JSONL tree is the
 *   source of truth (ADR 0001 decision 4) and re-ingesting it rebuilds every table.
 * - **`_ingest_state`** is the single mutable table: one row per JSONL source file, holding how many
 *   bytes of it are ingested, the SHA-256 of exactly those bytes, and whether it was ever rewritten.
 *   `core/eventlog/offsets.ts` is the pure model of how that row evolves.
 *
 * `k6_points` is declared here so the schema lives in one place, but it is filled by `perf:ingest`
 * (item 25) from k6's own JSON output, not by the event-log ingest.
 */

/** The append-only event tables, in declaration order. */
export const EVENT_TABLES = [
  "platform_events",
  "sql_events",
  "tx_events",
  "http_events",
  "queue_events",
  "backup_events",
  "lifecycle_events",
  "k6_points",
] as const;

export type EventTable = typeof EVENT_TABLES[number];

/** The one mutable table: per-source-file ingest offsets. */
export const INGEST_STATE_TABLE = "_ingest_state";

/** §4.1, verbatim apart from layout. Keyed by table name so callers can't miss one. */
export const EVENT_TABLE_DDL: Readonly<Record<EventTable, string>> = {
  platform_events: `CREATE TABLE IF NOT EXISTS platform_events (
  event_id VARCHAR, ts TIMESTAMP, level VARCHAR, role VARCHAR, pid INTEGER,
  trace_id VARCHAR, span_id VARCHAR, parent_span_id VARCHAR,
  app_id VARCHAR, kind VARCHAR, name VARCHAR,
  outcome VARCHAR, error_tag VARCHAR, duration_ms DOUBLE,
  attrs JSON, source_file VARCHAR, source_offset BIGINT
)`,
  sql_events: `CREATE TABLE IF NOT EXISTS sql_events (
  ts TIMESTAMP, trace_id VARCHAR, app_id VARCHAR,
  engine VARCHAR,
  dialect VARCHAR, statement_kind VARCHAR,
  table_name VARCHAR, sql_text VARCHAR, bind_count INTEGER,
  duration_ms DOUBLE, row_count BIGINT, outcome VARCHAR, error_tag VARCHAR
)`,
  tx_events: `CREATE TABLE IF NOT EXISTS tx_events (
  ts TIMESTAMP, trace_id VARCHAR, app_id VARCHAR, engine VARCHAR,
  outcome VARCHAR,
  operations INTEGER, duration_ms DOUBLE, queue_wait_ms DOUBLE, error_tag VARCHAR
)`,
  http_events: `CREATE TABLE IF NOT EXISTS http_events (
  ts TIMESTAMP, trace_id VARCHAR, method VARCHAR, path VARCHAR,
  app_id VARCHAR, kind VARCHAR, name VARCHAR, status INTEGER,
  duration_ms DOUBLE, bytes_in BIGINT, bytes_out BIGINT, error_tag VARCHAR
)`,
  queue_events: `CREATE TABLE IF NOT EXISTS queue_events (
  ts TIMESTAMP, queue VARCHAR, depth INTEGER, cap INTEGER,
  event VARCHAR, dropped BIGINT
)`,
  backup_events: `CREATE TABLE IF NOT EXISTS backup_events (
  ts TIMESTAMP, app_id VARCHAR, phase VARCHAR, key VARCHAR,
  bytes BIGINT, sha256 VARCHAR, duration_ms DOUBLE, outcome VARCHAR, error_tag VARCHAR
)`,
  lifecycle_events: `CREATE TABLE IF NOT EXISTS lifecycle_events (
  ts TIMESTAMP, role VARCHAR, pid INTEGER, phase VARCHAR, detail JSON
)`,
  k6_points: `CREATE TABLE IF NOT EXISTS k6_points (
  ts TIMESTAMP, run_id VARCHAR, metric VARCHAR, value DOUBLE,
  scenario VARCHAR, status VARCHAR, trace_id VARCHAR, tags JSON
)`,
};

/**
 * `source_file` is the path relative to `LOG_DIR` (`server/2026-10-10/events-14-31887-001.jsonl`), so
 * moving the log root does not orphan the offsets. `bytes_ingested` always ends just past a `\n`.
 * `prefix_sha256` is the lowercase hex SHA-256 of bytes `[0, bytes_ingested)` of that file.
 *
 * `dedupe` is not in §4.1: once a rewrite of the file has been detected, every line later read from
 * it is deduplicated on `eventId`, because the offset model can no longer vouch for it. Without it a
 * rewritten file can insert an old line twice — see "Once rewritten, always deduplicated" in
 * `core/eventlog/offsets.ts` and ADR 0004.
 */
export const INGEST_STATE_DDL = `CREATE TABLE IF NOT EXISTS _ingest_state (
  source_file VARCHAR PRIMARY KEY, bytes_ingested BIGINT,
  prefix_sha256 VARCHAR, last_ingested_at TIMESTAMP, dedupe BOOLEAN
)`;

/** Every statement needed to bring a fresh or existing event-log file up to this schema, in order. */
export const EVENTLOG_DDL: readonly string[] = [
  ...EVENT_TABLES.map((table) => EVENT_TABLE_DDL[table]),
  INGEST_STATE_DDL,
];
