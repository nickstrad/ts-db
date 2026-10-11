# DuckDB analysis queries

Read-only `.sql` files for analyzing ts-db's ingested event log (item 21) with the DuckDB CLI. They are not
the item-23 catalog: `platform/analysis/catalog.ts` and `scripts/logs.ts` have not landed (`deno task
logs:*`
points at a `scripts/logs.ts` that does not exist yet). Where a file mirrors a plan §4.3 named query, its
header says so, so item 23 can lift the SQL.

Every query here was last run against a real ingested event log on 2026-10-11 (DuckDB CLI v1.5.5 over a file
written by `@duckdb/node-api` 1.5.6). The results are in `docs/architecture/reflection-opus.md`.

## Getting data

- **Event-log database:** `Config.eventLog.duckdbPath`, env `EVENTLOG_DUCKDB`, default
  `<DATA_DIR>/eventlog.duckdb`. That is not the `logs/duckdb/events.duckdb` the plan's §4.1/§4.2 describe.
- **Producing JSONL:** `platform/server.ts` is not ported yet (item 22), so the HTTP server writes no event
  log. `seed.ts` stands in for it. It drives a tic-tac-toe workload through the landed layers (`LoggingLive`,
  `StorageLive`, `BackupsLive`, `ReaderClientLive` plus the real reader process), including rule, conflict,
  not-found and schema failures and two backups per app. A second process then runs `EventLogIngestLive`:

```sh
export DATA_DIR=/tmp/tsdb-seed/data LOG_DIR=/tmp/tsdb-seed/logs \
  LOCAL_OBJECT_DIR=/tmp/tsdb-seed/objects TRACE_SQL=true LOG_LEVEL=debug
deno run -A scripts/duckdb/seed.ts workload    # repeat for more processes; EVENT_QUEUE_CAPACITY=64 forces drops
deno run -A scripts/duckdb/seed.ts ingest      # idempotent: runs ingest twice, prints both reports
```

`TRACE_SQL=true` is needed for `sql_events`. `http_events`, handler records and `k6_points` stay empty:
nothing emits http/handler events until item 22, and `k6_points` is filled by `perf:ingest`.

## Running a query

Variables are DuckDB session variables, read with `getvariable()`. Set them with `SET VARIABLE` through
`-cmd`, which runs before the file is read from stdin. The DuckDB CLI has no `.parameter` command (that is the
SQLite shell's), and a bare `$name` placeholder fails with "Prepared statement parameters cannot be used
directly":

```sh
duckdb -readonly "$DATA_DIR/eventlog.duckdb" \
  -cmd "SET VARIABLE start_ts = '2026-10-11 00:00:00'" \
  -cmd "SET VARIABLE end_ts   = '2026-10-12 00:00:00'" \
  < scripts/duckdb/slowest-sql.sql
```

- `start_ts` / `end_ts` are optional everywhere. An unset bound means unbounded. The window is half-open,
  `[start_ts, end_ts)`, in UTC wall time (ingest stores each `ts` as UTC).
- `row_limit` is optional (`limit` is a reserved word, so it cannot be a variable name). `bucket` is an
  optional `INTERVAL` string such as `'10 seconds'`.
- `trace_id` (`trace-timeline.sql`) and `log_glob` (`log-level-distribution.sql`) are required.
- `log-level-distribution.sql` reads JSONL directly, so it runs before any ingest:
  `duckdb -cmd "SET VARIABLE log_glob = 'logs/*/*/events-*.jsonl'" < scripts/duckdb/log-level-distribution.sql`.
- Open the database `-readonly` so a query can never contend with a running ingest for the write lock.

## Schema notes

The tables and the JSONL-to-column mapping live in `core/eventlog/ddl.ts` and `platform/eventlog/tables.ts`.
Read those first; the parts that shape these queries are:

- **Every record lands in `platform_events`.** Records of a typed kind are copied to that kind's table as
  well. Never union `platform_events` with `sql_events`/`tx_events`/`http_events`, or every such event is
  counted twice.
- **The typed tables have no `event_id`.** They cannot be joined to `platform_events` exactly. Where a query
  needs both, it joins on `(trace_id, ts, statement_kind, duration_ms)` (sql) or `(ts, queue, event)` (queue).
- **An error is `error_tag IS NOT NULL`, not `outcome = 'error'`.** A failed transaction is
  `outcome = 'rollback'` with its tag. Only sql, backup and ingest records use outcome `error`.
- **`platform_events.kind`** is the event discriminant, except on handler records, where it is
  `query`/`mutation`. **`name`** is the most specific label: statementKind, queue, phase, sourceFile. Effect
  `log*` lines are `kind = 'lifecycle'`, `name = 'log'`.
- **`trace_id`** is per request only on the reader (`reader-<pid>-<frame id>`) and per backup run. Writer
  sql/tx fall back to the fiber id (`#2`), shared by every writer process, until item 22 annotates requests.
  `ReaderRequestFrame` carries no trace id, so no trace spans both processes yet. `trace-summary.sql`
  classifies the ids.
- **Field names differ by source.** The JSONL source is camelCase (`eventId`, `traceId`, `durationMs`); the
  tables are snake_case. Only `log-level-distribution.sql` reads JSONL.

## Query index

| File                            | Question it answers                                                                     | Reads                                         | Variables                         |
| ------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------- |
| `event-counts-by-type.sql`      | Event counts by role/kind/name/outcome.                                                 | `platform_events`                             | `start_ts`, `end_ts`              |
| `error-breakdown.sql`           | Errors by tag, role, kind, outcome and app, with share of errors and of all events.     | `platform_events`                             | `start_ts`, `end_ts`              |
| `recent-errors.sql`             | Newest errors and warnings with their detail.                                           | `platform_events`                             | `row_limit`                       |
| `log-level-distribution.sql`    | Log-level mix per role, straight from the JSONL (no ingest needed).                     | JSONL via `read_json`                         | `log_glob`                        |
| `slowest-sql.sql`               | p50/p95/p99 by engine, statement kind and table. Plan `slowest-sql`.                    | `sql_events`                                  | `start_ts`, `end_ts`              |
| `plan-shapes.sql`               | Distinct compiled SQL texts with counts, latency and rows. Plan `plan-shapes`.          | `sql_events`                                  | `start_ts`, `end_ts`, `row_limit` |
| `tx-outcomes.sql`               | Commit/rollback counts, error tags, tx and queue-wait times. Plan `tx-outcomes`.        | `tx_events`                                   | `start_ts`, `end_ts`              |
| `mutation-vs-query-latency.sql` | Writer vs reader transaction latency per time bucket. Plan `mutation-vs-query-latency`. | `tx_events`                                   | `start_ts`, `end_ts`, `bucket`    |
| `queue-depth.sql`               | Queue high-water, rejections and dropped events per process. Plan `queue-depth`.        | `queue_events` + `platform_events`            | `start_ts`, `end_ts`, `bucket`    |
| `backup-durations.sql`          | Per-app backup phases, durations, bytes, failures, gaps. Plan `backup-history`.         | `backup_events`                               | `start_ts`, `end_ts`              |
| `lifecycle-events.sql`          | Process lifecycle phases per role/pid with time between them.                           | `lifecycle_events`                            | `start_ts`, `end_ts`              |
| `ingest-health.sql`             | Per source file: bytes/rows ingested, rejected lines, rewrites, last movement.          | `_ingest_state` + `platform_events`           | —                                 |
| `trace-summary.sql`             | Longest/noisiest traces, classified request / process / fiber-fallback.                 | `platform_events`                             | `start_ts`, `end_ts`, `row_limit` |
| `trace-timeline.sql`            | Ordered timeline of one trace, with SQL text. Plan `trace`.                             | `platform_events` + `sql_events`, `k6_points` | `trace_id`                        |

Not written yet, because no data exists to check them against: `error-rate-by-handler` and
`handler-throughput` need http/handler events (item 22), and `k6-vs-platform` needs `k6_points` from
`perf:ingest` (item 25).

Every query is `SELECT`/`WITH` only, matching the plan's rule that only `INSERT` is ever issued against the
event tables (§4.1).
