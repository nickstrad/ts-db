# Observability

The server and reader write rotating JSONL event files. `logs:ingest` materializes their complete lines into
DuckDB; the named analysis catalog reads that database. JSONL is the source of truth while retained. Ingest
never changes event rows; it appends rows and updates source offsets. Rebuilding after retention can recover
only the JSONL files still available.

## Commands and configuration

Run these from the repository root, with Deno on `PATH`:

```sh
export PATH="$HOME/.deno/bin:$PATH"
deno task logs:ingest
deno run -A scripts/logs.ts list
deno task logs:query slowest-sql --format table
deno task logs:query handler-throughput --format json
deno task logs:query plan-shapes --format csv
deno task logs:sweep --dry-run
```

The existing `deno.json` supplies `logs:ingest`, `logs:query`, and `logs:sweep`. `list` uses the direct script
because there is no `logs:list` task. No package script is needed.

The CLI is a separate Effect program using `ConfigLive`, the reader event sink for ingest/sweep,
`EventLogIngestLive`, `AnalysisLive`, and the retention sweeper. It never loads the writer's SQLite stack.
Analysis opens the configured database read-only and closes its connection and instance after each call. Run
ingest once before querying a new database. A query failure exits nonzero; an empty result is successful and
prints `[]` in JSON or `(0 rows)` in table format. CSV has a header when rows exist and produces no output for
an empty result. BIGINT values are strings in JSON to preserve precision; timestamps are UTC strings.
Diagnostics go to stderr.

Use the same `LOG_DIR`, `DATA_DIR`, and `EVENTLOG_DUCKDB` settings as the server. Defaults in the landed
configuration are `LOG_DIR=./logs`, `DATA_DIR=./data`, and `EVENTLOG_DUCKDB=<DATA_DIR>/eventlog.duckdb`. The
plan's `logs/duckdb/events.duckdb` is an explicit override, not the current default. SQL events normally have
debug level; use `TRACE_SQL=1` (raises them to info) or `LOG_LEVEL=debug` on the server to capture them. Bind
values are excluded unless `LOG_INCLUDE_BIND_VALUES` is enabled.

The CLI accesses the file directly. DuckDB file locks prevent access if another process has an incompatible
connection open; stop that process before retrying. The current reader entrypoint still has placeholder ingest
and analysis RPC handlers. The CLI works independently; the admin HTTP routes do not become functional merely
by installing this catalog.

## Layout and retention

```text
logs/                                  # LOG_DIR
  server/2026-10-11/events-14-31887-001.jsonl
  reader/2026-10-11/events-14-31902-001.jsonl
  server/2026-10-01/events-09-31010-001.jsonl.gz
  server/2026-10-11/rejected.jsonl       # quarantined malformed lines
  k6/<run-id>/{raw.json,summary.json}    # perf output, outside event retention
data/eventlog.duckdb                    # default; override with EVENTLOG_DUCKDB
```

Files roll on UTC date change, hour change, or the size limit. The actual config defaults are:

| Setting               | Default            | Meaning                                                     |
| --------------------- | ------------------ | ----------------------------------------------------------- |
| `LOG_RETENTION_DAYS`  | 30                 | Delete expired files.                                       |
| `LOG_GZIP_AFTER_DAYS` | 7                  | Compress eligible older JSONL files.                        |
| `LOG_MAX_TOTAL_BYTES` | 1073741824 (1 GiB) | Retained event-file budget; oldest eligible files go first. |
| `LOG_MAX_FILE_BYTES`  | 67108864 (64 MiB)  | Rotation threshold.                                         |

These differ from plan §4.2's 14 days / 2 days / 2 GiB. Today's and future-dated directories are kept. The
in-process sweeper protects supplied open-file paths; the separate CLI cannot discover another process's open
files and relies on the date rule. Containment checks reject paths outside `LOG_DIR`; files changed during a
sweep are skipped. `rejected.jsonl` can age out but is never gzipped. A successful `--dry-run` inventories and
validates without writing files, including log files, and prints the plan. Refusals exit nonzero and are
printed on stderr.

The landed ingester **skips `.jsonl.gz`**. The landed sweeper does not verify committed ingest offsets before
compression/deletion and does not prune `_ingest_state`. Before a real sweep, stop log producers, ingest all
remaining plain JSONL, inspect errors and rejected lines, and then sweep. The stronger ingest-before-retention
coordinator from item 36 is absent from this checkout; do not assume concurrent ingest and sweeping are
lossless. A partially written final line is deferred until its newline arrives.

```sh
# After stopping producers and resolving ingest errors:
deno task logs:ingest
deno task logs:sweep --dry-run
deno task logs:sweep
```

Retention protects recent/open files even when they exceed the configured byte budget. That budget does not
cap the derived database, the k6 directory, or arbitrary files under `LOG_DIR`. **DuckDB event-table pruning
is out of scope: DuckDB grows until a future `logs:compact`.** No such command exists yet. Logger drops,
rejected lines, and ingested events are separate counts; ingest cannot recover an event dropped before
reaching JSONL.

## Tables and columns

These definitions match `core/eventlog/ddl.ts`. All event-table columns are nullable. Timestamps are stored as
UTC wall time; durations and waits are milliseconds; byte counts are bytes. Optional or wrong-typed event
fields become SQL NULL. Every accepted source record has a `platform_events` row; typed event kinds also have
one row in their corresponding typed table. Do not add those counts together.

```sql
CREATE TABLE platform_events (
  event_id VARCHAR, ts TIMESTAMP, level VARCHAR, role VARCHAR, pid INTEGER,
  trace_id VARCHAR, span_id VARCHAR, parent_span_id VARCHAR,
  app_id VARCHAR, kind VARCHAR, name VARCHAR,
  outcome VARCHAR, error_tag VARCHAR, duration_ms DOUBLE,
  attrs JSON, source_file VARCHAR, source_offset BIGINT
);
CREATE TABLE sql_events (
  ts TIMESTAMP, trace_id VARCHAR, app_id VARCHAR,
  engine VARCHAR, dialect VARCHAR, statement_kind VARCHAR,
  table_name VARCHAR, sql_text VARCHAR, bind_count INTEGER,
  duration_ms DOUBLE, row_count BIGINT, outcome VARCHAR, error_tag VARCHAR
);
CREATE TABLE tx_events (
  ts TIMESTAMP, trace_id VARCHAR, app_id VARCHAR, engine VARCHAR,
  outcome VARCHAR, operations INTEGER, duration_ms DOUBLE,
  queue_wait_ms DOUBLE, error_tag VARCHAR
);
CREATE TABLE http_events (
  ts TIMESTAMP, trace_id VARCHAR, method VARCHAR, path VARCHAR,
  app_id VARCHAR, kind VARCHAR, name VARCHAR, status INTEGER,
  duration_ms DOUBLE, bytes_in BIGINT, bytes_out BIGINT, error_tag VARCHAR
);
CREATE TABLE queue_events (
  ts TIMESTAMP, queue VARCHAR, depth INTEGER, cap INTEGER,
  event VARCHAR, dropped BIGINT
);
CREATE TABLE backup_events (
  ts TIMESTAMP, app_id VARCHAR, phase VARCHAR, key VARCHAR,
  bytes BIGINT, sha256 VARCHAR, duration_ms DOUBLE, outcome VARCHAR, error_tag VARCHAR
);
CREATE TABLE lifecycle_events (
  ts TIMESTAMP, role VARCHAR, pid INTEGER, phase VARCHAR, detail JSON
);
CREATE TABLE k6_points (
  ts TIMESTAMP, run_id VARCHAR, metric VARCHAR, value DOUBLE,
  scenario VARCHAR, status VARCHAR, trace_id VARCHAR, tags JSON
);
CREATE TABLE _ingest_state (
  source_file VARCHAR PRIMARY KEY, bytes_ingested BIGINT,
  prefix_sha256 VARCHAR, last_ingested_at TIMESTAMP, dedupe BOOLEAN
);
```

Column meanings:

- Common event fields: `ts` is event time, `app_id` identifies the app, `trace_id` correlates work,
  `duration_ms` measures the operation, `outcome` is its result, and `error_tag` is its tagged failure.
- `platform_events`: `event_id` identifies an event; `level` is debug/info/warn/error; `role` and `pid`
  identify the emitting process. `span_id` and `parent_span_id` describe nested spans when provided. `kind` is
  the event discriminant except that handler records map to query/mutation. `name` is the handler name, SQL
  statement kind, queue name, phase, or ingest source file, depending on the kind. `outcome` also holds queue
  event names or ingest status. `attrs` contains error detail, or lifecycle detail. `source_file` is relative
  to `LOG_DIR`; `source_offset` is the source line's starting byte.
- `sql_events`: `engine` is sqlite/duckdb; `dialect` names the compiler dialect; `statement_kind` identifies
  select/insert/update/delete/ddl/pragma; `table_name` names the table; `sql_text` is the compiled statement;
  `bind_count` counts bound arguments; `row_count` counts result or affected rows when known. Outcomes are
  ok/error.
- `tx_events`: `engine` identifies the database; `outcome` is commit/rollback/interrupted; `operations` counts
  operations; `queue_wait_ms` measures waiting before execution.
- `http_events`: `method` and `path` describe the request; `kind` is query/mutation; `name` names the routed
  handler; `status` is the response status; `bytes_in`/`bytes_out` measure payload sizes. `duration_ms` covers
  server request handling, including IPC for queries. Health and admin routes also receive synthetic handler
  names in this table.
- `queue_events`: `queue` identifies writer/reader/event-sink queues; `depth` is observed occupancy; `cap` is
  capacity; `event` is high-water/rejected/dropped; `dropped` is the count represented by a drop report (not
  the number of reports).
- `backup_events`: `phase` is snapshot/verify/hash/put-object/put-manifest/publish-latest; `key` is the
  object-store key; `bytes` is snapshot size; `sha256` is the snapshot checksum. Outcomes are ok/error. An ok
  publish-latest completes a backup. Not every phase supplies every field.
- `lifecycle_events`: `role` and `pid` identify the process; `phase` names the lifecycle/log event; `detail`
  is its structured diagnostic payload.
- `k6_points`: `run_id` identifies the load run; `metric` names the measurement; `value` is the sample in the
  metric's units (http_req_duration uses milliseconds); `scenario` identifies the load scenario; `status` is
  the request status tag; `tags` holds the remaining k6 tags. Item 25's producer fills this table; JSONL
  platform ingest does not. That producer is absent in this checkout.
- `_ingest_state`: `source_file` is the relative source identity; `bytes_ingested` ends after the last
  committed newline; `prefix_sha256` hashes that committed prefix; `last_ingested_at` is the ingest timestamp;
  `dedupe` remains true after a rewrite so later batches check event IDs. `dedupe` is an addition to plan
  §4.1. This is the only mutable table.

## Query catalog

Every SQL entry is a SELECT or WITH statement. Callers pass a catalog name and bound values, never SQL.
Unknown names (including object-prototype names) produce `UnknownAnalysisQuery` and the complete valid-name
list. Unknown parameters, duplicate CLI parameters, missing required values, invalid timestamps, and reversed
time windows fail.

All entries except `trace` accept optional `since` (inclusive) and `until` (exclusive), in ISO format with an
explicit timezone, for example `2026-10-11T00:00:00Z`. Omission means unbounded. `trace` requires `traceId`
and has no time or row limit. NULL durations are excluded from percentiles by DuckDB.

<!-- catalog:start -->

| Name                        | Question it answers                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `slowest-sql`               | What are SQL p50/p95/p99 durations by engine, statement kind and table?                                                  |
| `plan-shapes`               | Which compiled SQL texts run, how often, and with what p50/p95/p99 latency?                                              |
| `error-rate-by-handler`     | How many requests/errors does each app/handler have, at what rate and with which error tags?                             |
| `mutation-vs-query-latency` | How do mutation (writer) and query (reader) server-request p50/p95/p99 compare by minute?                                |
| `handler-throughput`        | How many requests does each app/handler receive per minute, broken down by HTTP status?                                  |
| `queue-depth`               | What are each queue's observed high-water depths, rejections and dropped-event counts per minute?                        |
| `tx-outcomes`               | How many commits, rollbacks and interruptions occur, with what queue waits and execution latency?                        |
| `backup-history`            | Which backup phases succeeded or failed, how long and large were they, and what were the gaps between completed backups? |
| `trace`                     | What is the complete ordered platform event timeline for one trace across server and reader?                             |
| `k6-vs-platform`            | How does k6 client p95 compare with traced server-request p95 per 10-second bucket and scenario?                         |

<!-- catalog:end -->

`plan-shapes` groups by SQL text; it does not run EXPLAIN or prove an index was used. Compare text and latency
across controlled runs to investigate indexing. `error-rate-by-handler` treats HTTP status

> =400 or an error tag as a failure; the rate is a fraction, not a percentage. Each error tag gets a row with
> the same handler totals, so do not sum those repeated totals. Untagged failures are labelled by HTTP status.
> Successful handlers still get a row with zero errors.

Throughput counts are per calendar minute (partial minutes are not extrapolated). Latency uses HTTP durations
for both paths, including queueing, IPC and response preparation. Queue rows are observations, not periodic
samples; no queue rows does not prove a queue remained empty. Backup gaps appear only on successful
publish-latest rows and can look back before `since`; the first success has NULL gap.

`trace` reads the canonical platform rows once, without unioning duplicate typed rows. Source file and offset
identify the original JSONL payload, where full typed details can be inspected. Missing/dropped events cannot
be reconstructed. The current reader uses its own request trace IDs, so a client trace may not yet include
reader SQL; trace propagation is a runtime prerequisite outside this catalog's scope.

`k6-vs-platform` selects http_req_duration samples, matches server requests by nonempty trace ID and the same
UTC 10-second bucket, and deduplicates matched HTTP rows before calculating p95. It returns only matched
buckets/scenarios; it does not attribute all server traffic to every k6 scenario. It pools runs within each
scenario/bucket. Client samples include unmatched measurements in that bucket; sample counts are included to
expose differences. Reused trace IDs can associate multiple requests; missing trace tags or requests
straddling bucket boundaries reduce matches. Comparing two different sample populations does not guarantee
client p95 >= server p95. Meaningful comparison needs unique request traces and the item-25 producer.

## Worked examples

For a fresh local dataset, start a server with SQL tracing and explicit paths. Use these same exports in the
terminal that runs the CLI:

```sh
export DATA_DIR=/tmp/tsdb-observe-data
export LOG_DIR=/tmp/tsdb-observe-logs
export EVENTLOG_DUCKDB=/tmp/tsdb-observe-data/events.duckdb
export TRACE_SQL=1
export BACKUP_INTERVAL_MS=60000
deno task serve
```

In the other terminal, create a request whose trace ID you know. The response includes `X-Trace-Id`; if you
omit the request header, use that generated response value instead.

```sh
curl -i http://127.0.0.1:8000/apps/tic-tac-toe/mutation/createGame \
  -H 'Authorization: Bearer dev-only' -H 'Content-Type: application/json' \
  -H 'X-Trace-Id: analysis-example' \
  --data '{"xPlayer":"alice","oPlayer":"bob"}'
deno task logs:ingest
deno task logs:query trace --param traceId=analysis-example --format json
deno task logs:query slowest-sql --format csv
deno task logs:query error-rate-by-handler --format json
```

The sink flushes asynchronously; repeat ingest after the flush, or stop the server gracefully first to drain
its sink. Ingest only processes complete newline-terminated records and is idempotent for unchanged files.

```sh
deno task logs:query handler-throughput \
  --param since=2026-10-11T00:00:00Z --param until=2026-10-12T00:00:00Z
deno task logs:query backup-history --format json
deno task logs:query not-a-query   # nonzero; UnknownAnalysisQuery with valid names
```

For load data, run `deno task perf:mixed` against the local server, then ingest and query. The mixed task does
not create its artifact directory or request raw JSON by default; set `K6_RUN_ID` and `K6_OUT` and create
`logs/k6/<run-id>` when collecting raw samples. `deno task perf:ingest` points to item 25's currently missing
`perf/ingest_k6.ts`. Until that producer lands, platform ingest alone cannot populate `k6_points`, and
`k6-vs-platform` will legitimately return no rows.
