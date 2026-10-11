# DuckDB analysis queries

Read-only SQL for the schema landed in item 21: `core/eventlog/ddl.ts`, populated by
`platform/eventlog/ingest.ts` with mappings in `platform/eventlog/tables.ts`. Verified on 2026-10-11 against
d6e08cd using actual reader logs and live storage/backup events. The ingest library uses DuckDB 1.5.6; the
installed CLI used for these queries is 1.5.5.

## Current runtime boundary

The reader writes rotating JSONL, but its `ingest` RPC still returns `IngestError`.
`platform/analysis/catalog.ts`, `scripts/logs.ts`, retention and `perf/ingest_k6.ts` have not landed.
Consequently the `logs:*` tasks declared in deno.json are not usable yet. There is no item-23 catalog to run.
The server's compatibility facades do not mount the JSONL logger. Ordinary integration runs therefore populate
reader SQL, transaction and lifecycle events, not server HTTP or backup events.

To ingest existing logs now, explicitly compose the landed library in a **separate process**, never import
DuckDB into the writer server. From the repository root (close other writers to the target DuckDB file):

```sh
export PATH="$HOME/.deno/bin:$HOME/.local/bin:$PATH"
# Replace these with the actual log directory and derived database path.
log_dir=/tmp/reflection-astra-evidence/integration-logs
event_db=/tmp/reflection-astra-evidence/events.duckdb

deno eval '
import { Effect, Layer } from "effect";
import { ConfigTest } from "./platform/config.ts";
import { EventSink } from "./platform/services.ts";
import { makeEventLogIngest } from "./platform/eventlog/ingest.ts";
const deps = Layer.mergeAll(
  ConfigTest({ logging: { dir: Deno.args[0] }, eventLog: { duckdbPath: Deno.args[1] } }),
  Layer.succeed(EventSink, { emit: e => Effect.sync(() => console.error(JSON.stringify(e))) }),
);
console.log(await Effect.runPromise(
  Effect.scoped(Effect.flatMap(makeEventLogIngest(), s => s.ingest)).pipe(Effect.provide(deps)),
));
' "$log_dir" "$event_db"
```

This closes the ingest handle before the CLI opens the database. The configured production default is
`EVENTLOG_DUCKDB`, or `<DATA_DIR>/eventlog.duckdb`; no database file is checked into this repository. A
repeated ingest of unchanged files should report zero lines ingested.

## Running queries

These files use SQL session variables via `getvariable()`. The installed DuckDB CLI has **no `.parameter`
dot-command**. Set variables in the same connection before reading the query. Bounds are UTC timestamps, start
inclusive and end exclusive. Set every required variable: an unset variable evaluates to NULL and can silently
produce an empty result.

```sh
duckdb "$event_db" -readonly -bail <<'SQL'
SET VARIABLE start_ts = TIMESTAMP '2026-10-11 00:00:00';
SET VARIABLE end_ts = TIMESTAMP '2026-10-12 00:00:00';
.read scripts/duckdb/slowest-sql.sql
SQL

duckdb "$event_db" -readonly -bail <<'SQL'
SET VARIABLE row_limit = 100;
.read scripts/duckdb/recent-errors.sql
SQL

duckdb "$event_db" -readonly -bail <<'SQL'
-- Select a trace from this database, or assign a known trace string.
SET VARIABLE trace_id = (SELECT trace_id FROM platform_events WHERE kind = 'sql' ORDER BY ts LIMIT 1);
.read scripts/duckdb/trace-timeline.sql
SQL

duckdb -bail <<'SQL'
SET VARIABLE log_glob = '/tmp/reflection-astra-evidence/integration-logs/*/*/events-*.jsonl';
.read scripts/duckdb/log-level-distribution.sql
SQL
```

## Query index

| File                         | Purpose                                                       | Variables        |
| ---------------------------- | ------------------------------------------------------------- | ---------------- |
| `event-counts-by-type.sql`   | Canonical event counts with handler kind separated            | start_ts, end_ts |
| `error-breakdown.sql`        | Failure records by tag, percentage of failures and events     | start_ts, end_ts |
| `log-level-distribution.sql` | Levels directly from JSONL, without ingest                    | log_glob         |
| `slowest-sql.sql`            | Successful SQL p50/p95/p99 by engine, statement and table     | start_ts, end_ts |
| `backup-durations.sql`       | Emitted phase statistics and gaps between completed backups   | start_ts, end_ts |
| `lifecycle-events.sql`       | Process phases and elapsed time, including Effect log records | start_ts, end_ts |
| `recent-errors.sql`          | Failures, including rollback/interrupted transactions         | row_limit        |
| `trace-timeline.sql`         | One canonical row per ingested event for a trace              | trace_id         |
| `transaction-outcomes.sql`   | Commit/rollback/interrupted counts and p95 latency            | start_ts, end_ts |
| `ingest-coverage.sql`        | Source offsets, sticky dedupe flags and accepted event counts | none             |

## Interpretation limits

- Every accepted record enters `platform_events`; typed tables project those same records. Do not union them
  into a trace timeline: that duplicates events. Typed rows lack event_id, so an exact join back is not
  generally available. The canonical timeline does not expose typed-only fields such as sql_text.
- `platform_events.kind` maps handler events to `query`/`mutation`; the counts query normalizes them to
  `handler` with a separate handler_kind. Other kinds retain their discriminant.
- `attrs` maps errorDetail, or lifecycle.detail. It is not a copy of the complete event.
- Failure queries count event records, not failed HTTP requests: one failed operation can emit several
  records. They include error tags, error-level logs and error/rollback/interrupted outcomes. A NULL tag means
  the emitter supplied none. An error HTTP status without any of these indicators is not inferred here because
  status lives only in http_events.
- The SDK's trace header is not propagated through server/reader IPC yet. Current reader IDs are process-local
  `reader-<pid>-<request-id>`; a timeline is not an end-to-end trace.
- ObjectStore emits put-object records as well as Backups phase records; phase counts and byte sums are
  emitted records, not unique object transfers. Backup gaps compare completions inside the selected window.
- Lifecycle events include phase `log` from the Effect logger. Grouping by role/pid does not distinguish PID
  reuse across sufficiently long histories.
- `k6_points` has a schema but no landed producer. k6 metric values have different units and must not all be
  relabeled duration_ms. HTTP and k6 tables were empty in this reflection's real event log.
- Offsets are byte positions; rejected/duplicate lines and incomplete tails mean byte counts are not event
  counts. `ingest-coverage.sql` does not measure current filesystem size or unread backlog.
- The SQL files are SELECT/WITH only; session-variable setup changes no persistent data.
