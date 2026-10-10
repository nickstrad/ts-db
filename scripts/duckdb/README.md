# DuckDB analysis queries (starter set)

Starter `.sql` files for analyzing ts-db's event logs and (once built) the DuckDB event-log database. These
are read-only reference queries, not a query catalog or CLI — that's item 23's `platform/analysis/catalog.ts`
and `scripts/logs.ts`, which are **not built yet** and are out of scope here.

## Status: `duckdb` CLI is not installed on this machine

`which duckdb` found nothing. None of the queries below have been executed against real data. To install and
try them:

```sh
curl -fsSL https://install.duckdb.org | sh    # or: brew install duckdb / your package manager
export PATH="$HOME/.duckdb/cli/latest:$PATH"
duckdb --version
```

## Status: the DuckDB event-log database does not exist yet

Items 21 (JSONL ingest), 22, and 23 (query catalog) from `docs/plans/effect-port-and-observability.md` have
not landed. There is no `logs/duckdb/events.duckdb` file and no `platform_events` / `sql_events` / `tx_events`
/ `http_events` / `queue_events` / `backup_events` / `lifecycle_events` / `k6_points` tables populated
anywhere today.

Every query below that reads one of those tables is marked **planned schema (items 21-23 not yet landed)** —
it is written against the table shapes in the plan's §4.1, but cannot run until the ingest pipeline exists.
**`log-level-distribution.sql` is the one query here that works against real files today**, because it reads
the rotated JSONL logs directly with DuckDB's `read_json`, bypassing the (not yet built) DuckDB database
entirely.

## Schema notes and assumptions

- Table/column names (snake_case: `event_id`, `trace_id`, `duration_ms`, …) come verbatim from the plan's §4.1
  `CREATE TABLE` statements.
- The JSONL log lines (read directly by `log-level-distribution.sql`) use the **camelCase** envelope fields
  from `core/events.ts`'s `toJsonLine` (`eventId`, `ts`, `level`, `role`, `pid`, `traceId`, `spanId`,
  `parentSpanId`, `appId`, `kind`, plus per-kind fields) — not the DuckDB tables' snake_case names. Don't mix
  the two field-naming conventions across queries.
- `core/events.ts` notes two open ambiguities in the plan that items 11/23 still need to resolve, which these
  queries inherit as assumptions:
  - `platform_events.kind` is asked to carry both the event-kind discriminant
    (`http | handler |
    sql | tx | queue | backup | lifecycle | ingest`) _and_, for handler events, the
    routed handler's `query`/`mutation` distinction (`handlerKind`). `event-counts-by-type.sql` assumes the
    discriminant sense.
  - `EventRecord` has no `attrs` field; error payloads live in `errorDetail` today. `attrs JSON` in
    `platform_events` is assumed to be `errorDetail` mapped over by item 11 — see `recent-errors.sql`.
- `backup_events` and `lifecycle_events` carry no `trace_id` column in the plan's DDL, so `trace-timeline.sql`
  only unions the five tables that do (`platform_events`, `sql_events`, `tx_events`, `http_events`,
  `k6_points`).
- `BackupPhase` (`core/errors.ts`) is
  `snapshot | verify | hash | put-object | put-manifest |
  publish-latest`, in that order;
  `backup-durations.sql` treats a successful `publish-latest` row as "backup completed" for its gap
  calculation, noted inline in the file.

## Running a query

Query files use DuckDB CLI **named parameters** (`$start_ts`, `$end_ts`, `$trace_id`, `$limit`, `$log_glob`),
set with the shell's `.parameter set` dot-command before piping the file in:

```sh
duckdb logs/duckdb/events.duckdb \
  -c ".parameter set start_ts '2026-10-01 00:00:00'" \
  -c ".parameter set end_ts   '2026-10-02 00:00:00'" \
  < scripts/duckdb/slowest-sql.sql
```

For `log-level-distribution.sql` (no DuckDB file needed — reads JSONL directly, any in-memory or on-disk
DuckDB connection works):

```sh
duckdb \
  -c ".parameter set log_glob 'logs/server/2026-10-10/events-*.jsonl'" \
  < scripts/duckdb/log-level-distribution.sql
```

Widen `log_glob` to cover every role/date, e.g. `'logs/*/*/events-*.jsonl'`.

## Query index

| File                         | Question it answers                                                                                          | Reads                                                                                | Variables              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------- |
| `event-counts-by-type.sql`   | Event counts by kind/name/outcome over a time window.                                                        | `platform_events` _(planned)_                                                        | `$start_ts`, `$end_ts` |
| `error-breakdown.sql`        | Errors grouped by `error_tag`, with counts and share of total errors/events.                                 | `platform_events` _(planned)_                                                        | `$start_ts`, `$end_ts` |
| `log-level-distribution.sql` | Distribution of log levels (`debug`/`info`/`warn`/`error`).                                                  | rotated JSONL files, via `read_json` — **works today**                               | `$log_glob`            |
| `slowest-sql.sql`            | p50/p95/p99 `duration_ms` by engine, statement kind and table. Mirrors the plan's named `slowest-sql` query. | `sql_events` _(planned)_                                                             | `$start_ts`, `$end_ts` |
| `backup-durations.sql`       | Per-app backup phases, durations, bytes, failures, and gaps between successful backups.                      | `backup_events` _(planned)_                                                          | `$start_ts`, `$end_ts` |
| `lifecycle-events.sql`       | Startup/shutdown (and other) phases per role/pid, with time between phases.                                  | `lifecycle_events` _(planned)_                                                       | `$start_ts`, `$end_ts` |
| `recent-errors.sql`          | Most recent errors with detail/attrs, newest first.                                                          | `platform_events` _(planned)_                                                        | `$limit`               |
| `trace-timeline.sql`         | Complete ordered event timeline for one `trace_id` across tables. Mirrors the plan's named `trace` query.    | `platform_events`, `sql_events`, `tx_events`, `http_events`, `k6_points` _(planned)_ | `$trace_id`            |

All queries are `SELECT`/`WITH` only — none ever `INSERT`/`UPDATE`/`DELETE`, matching the plan's "only
`INSERT` is ever issued against the event tables" invariant (§4.1): these are read paths only.
