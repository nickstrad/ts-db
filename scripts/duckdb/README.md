# DuckDB analysis queries (starter set)

Starter `.sql` files for exploring ts-db's event logs with the `duckdb` CLI, written against the **v2** event
log schema (`core/eventlog/ddl.ts`). These are ad-hoc reference queries. The supported interface is the named
query catalog — `platform/analysis/catalog.ts` via `deno task logs:query <name>` — documented in
`docs/observability.md`; the files here overlap it where noted and otherwise stay free-form.

## Status

- **Schema:** `deno task logs:ingest` populates `EVENTLOG_DUCKDB` (default `<DATA_DIR>/eventlog.duckdb`). Stop
  the server before opening that file from another process.
- **Validation:** the reflection harness executes the current files and item-23 catalog through the pinned
  DuckDB Node API, with bound parameters, against real HTTP/k6 traffic ingested from JSONL. It requires every
  query to return rows; no synthetic event rows are inserted. See the reproduction command below.
- **v2 columns:** `platform_events.kind` is now `event_kind` (the record's kind) plus `handler_kind`
  (`query`/`mutation`); `http_events.kind` is `handler_kind`; `backup_events` gained `emitter`, `run_id` and
  `attempts`; every typed table has `event_id`.

## Schema notes and assumptions

- Table/column names are snake_case, as in `core/eventlog/ddl.ts`. The JSONL log lines (read directly by
  `log-level-distribution.sql`) use the **camelCase** envelope fields from `core/events.ts`'s `toJsonLine`
  (`eventId`, `traceId`, `spanId`, `appId`, `kind`, …). Don't mix the two conventions across queries.
- `platform_events.attrs` is the record's kind-specific JSON payload, including `errorDetail`.
- `backup_events`, `lifecycle_events` and `queue_events` carry no `trace_id`, so `trace-timeline.sql` only
  unions the five tables that do (`platform_events`, `sql_events`, `tx_events`, `http_events`, `k6_points`).
  Typed events appear in both `platform_events` and their typed table; both trace queries exclude the
  canonical SQL/transaction/HTTP copies so each event appears once.
- `sql_events` are only written when `TRACE_SQL=true` (or `LOG_LEVEL=debug`); without it `slowest-sql.sql`
  returns nothing.
- `BackupPhase` (`core/errors.ts`) is `snapshot | verify | hash | put-object | put-manifest | publish-latest`.
  `backup-durations.sql` keeps only `emitter = 'backups'` rows (the phases) and treats a successful
  `publish-latest` as "backup completed".

## Running the real-data check

From the repository root, with Deno, Docker and k6 available:

```sh
bash work-scripts/bash/ci-isolated-postgres.sh deno run -A work-scripts/deno/reflection-live-analysis.ts
```

This starts its own disposable Postgres, drives both legacy layouts and two tenant files, emits tenant admin
activity, creates queue high-water and reader-restart events, stops the servers, ingests their JSONL, and
loads real k6 points into the private event-log file. It executes every SQL file and all ten catalog entries.
All resources belong to this run; it does not use developer or E2E resources. Scratch data is removed on
success unless `KEEP_REFLECTION_DATA=1`; failures print the retained path.

For an existing stopped server, the supported operator interface remains `deno task logs:query <name>`. The
ad-hoc files use named bind parameters (`$start_ts` inclusive, `$end_ts` exclusive, `$trace_id`, `$limit`,
`$log_glob`); the harness demonstrates `connection.runAndReadAll(sql, bindings)` without SQL interpolation.
`log-level-distribution.sql` reads raw JSONL with camelCase fields; the rest read ingested tables.

## Tenant attribution limit

These are admin-global analyses. Schema v2 has no trusted tenant identity in its event envelope or typed
tables, even for real tenant requests. App IDs identify the registered application, not the tenant, and
callers control trace IDs. A safe `error-rate-by-tenant` requires emitter/context propagation and a versioned
ingest schema change first. `admin-tenant-activity.sql` reports control-plane HTTP operations only; it must
not be presented as tenant-scoped application analysis.

The k6 loader defaults to `logs/k6/<run-id>/k6.duckdb`. The named catalog reads `k6_points` in its own
event-log file; the harness explicitly loads those points into its stopped private event log. The catalog's
current time-bucket comparison includes all server HTTP events, so mixed tenant/admin traffic can contaminate
the comparison. The separate observability acceptance test filters server traces to its run.

## Query index

| File                         | Question it answers                                                                                          | Reads                                                                    | Variables              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------- |
| `event-counts-by-type.sql`   | Event counts by kind/name/outcome over a time window.                                                        | `platform_events`                                                        | `$start_ts`, `$end_ts` |
| `error-breakdown.sql`        | Errors grouped by `error_tag`, with counts and share of total errors/events.                                 | `platform_events`                                                        | `$start_ts`, `$end_ts` |
| `log-level-distribution.sql` | Distribution of log levels (`debug`/`info`/`warn`/`error`).                                                  | rotated JSONL files, via `read_json`                                     | `$log_glob`            |
| `slowest-sql.sql`            | p50/p95/p99 `duration_ms` by engine, statement kind and table. Mirrors the plan's named `slowest-sql` query. | `sql_events`                                                             | `$start_ts`, `$end_ts` |
| `backup-durations.sql`       | Per-app backup phases, durations, bytes, failures, and gaps between successful backups.                      | `backup_events`                                                          | `$start_ts`, `$end_ts` |
| `lifecycle-events.sql`       | Startup/shutdown (and other) phases per role/pid, with time between phases.                                  | `lifecycle_events`                                                       | `$start_ts`, `$end_ts` |
| `recent-errors.sql`          | Most recent errors with detail/attrs, newest first.                                                          | `platform_events`                                                        | `$limit`               |
| `trace-timeline.sql`         | Complete ordered event timeline for one `trace_id` across tables. Mirrors the plan's named `trace` query.    | `platform_events`, `sql_events`, `tx_events`, `http_events`, `k6_points` | `$trace_id`            |

| `admin-tenant-activity.sql` | Tenant/key admin HTTP operations, status and latency; no application tenant
attribution. | `http_events` | `$start_ts`, `$end_ts` | | `reader-restarts.sql` | Supervision attempts,
backoff, recovery PID and exhausted breaker events. | `lifecycle_events` | `$start_ts`, `$end_ts` |

All queries are `SELECT`/`WITH` only — none ever `INSERT`/`UPDATE`/`DELETE`, matching the plan's "only
`INSERT` is ever issued against the event tables" invariant (§4.1): these are read paths only.
