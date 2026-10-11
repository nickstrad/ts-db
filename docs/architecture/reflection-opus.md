# Reflection pass — code lens (Opus)

- **Date:** 2026-10-11
- **Branch:** `reflection/opus`, cut from `origin/main` at `d6e08cd`
- **Lens:** code (tests, queries, implementation quality). The diagram lens runs separately.
- **Phases followed:** repo-root `AGENTS.md` § "Reflection pass" phases 2–4. Phase 1 (diagrams) belongs to the
  architecture lens.

## 1. Test results

The full suite was run on this checkout as the `deno task ci` steps, plus `integration`.

| Task                                  | Result                                             | Wall time                     |
| ------------------------------------- | -------------------------------------------------- | ----------------------------- |
| `test` (`tests/unit/**`, `core_test`) | **349 passed / 0 failed / 1 ignored** (15 modules) | 36.6 s                        |
| `test:prop` (`tests/property/**`)     | **63 passed / 0 failed / 3 ignored** (12 modules)  | 71.7 s                        |
| `integration`                         | **PASS**                                           | 3.4 s                         |
| `lint`                                | pass (87 files)                                    | <1 s                          |
| `check`                               | pass                                               | <1 s (cached)                 |
| `fmt:check`                           | **FAIL**: 2 files on `main`                        | <1 s                          |
| **Total**                             | **412 passed / 0 failed / 4 ignored**              | about 1 min 52 s of test time |

**Failures.** No test fails. `fmt:check` fails on the base commit, so `deno task ci` is red on `main`:

- `AGENTS.md`: a list item reflowed. It has been unformatted since `d6e08cd`, the commit that added the
  reflection pass.
- `docs/plans/multitenancy.md`: around lines 220 and 314. It is unformatted at `c77d0de`, the MT plan fix, and
  in earlier MT commits.

Neither file is in this lens's allowed set, so both are recorded and left unfixed. Running `deno fmt` on the
two files fixes them.

**Ignored tests (4), all deliberate:**

| Test                                                                                       | File                                       | Why skipped                                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------ |
| real S3: backup round trip over ObjectStoreS3 publishes latest.json last and restores      | `tests/unit/backup_test.ts:684`            | Runs only with `S3_INTEGRATION=1` and a live endpoint.                         |
| oracle known issue 1a: json layout, eq on a number field holding an integral double ≥ 2^53 | `tests/property/sqlite_oracle_test.ts:276` | Known bug. Ignored unless `ORACLE_KNOWN_ISSUES=1`, and fails when that is set. |
| oracle known issue 1b: json layout, countBy over a number field holding 2^53               | `tests/property/sqlite_oracle_test.ts:295` | Same as 1a.                                                                    |
| oracle known issue 2: node:sqlite truncates TEXT at U+0000 on read                         | `tests/property/sqlite_oracle_test.ts:310` | Same as 1a (an upstream `node:sqlite` limitation).                             |

The three oracle tests are **open correctness bugs parked as ignored tests**, not flaky tests. Section 3
covers them.

## 2. Query audit

### 2.1 Data used

Before this pass no event log existed: no `logs/`, no event-log DuckDB file. The live server
(`platform/server.ts`) is not ported yet (item 22), so it writes no JSONL.

`scripts/duckdb/seed.ts` (new) drives a tic-tac-toe workload through the **landed** layers:

- `LoggingLive`;
- per-app `StorageLive` + `BackupsLive` over `ObjectStoreLocal`;
- `ReaderClientLive`, which spawns the real `platform/reader.ts`.

A second process then runs `EventLogIngestLive`.

Steps run:

1. Two normal workload runs and one run with `EVENT_QUEUE_CAPACITY=64 EVENT_FLUSH_MS=1000`, to produce real
   `dropped` queue events.
2. Three malformed lines appended to one server file (bad `ts`, not JSON, no `eventId`), to exercise
   quarantine.
3. Ingest, twice each time. The second ingest of a pair inserts nothing, which confirms idempotence.

Resulting database: `DATA_DIR/eventlog.duckdb`, 7 source files from 7 processes.

| Table             | Rows | Table              | Rows                          |
| ----------------- | ---- | ------------------ | ----------------------------- |
| `platform_events` | 3793 | `backup_events`    | 70                            |
| `sql_events`      | 2559 | `lifecycle_events` | 33                            |
| `tx_events`       | 1121 | `queue_events`     | 9                             |
| `http_events`     | 0    | `k6_points`        | 0                             |
| `_ingest_state`   | 7    | rejected lines     | 3 (`server/…/rejected.jsonl`) |

`http_events`, handler records and `k6_points` are empty because nothing emits them yet (items 22 and 25).

Every query ran through the DuckDB CLI v1.5.5 against that file, once with variables unset and once with a
window (`start_ts`, `end_ts`, `row_limit=5`, `bucket='10 seconds'`). **All 14 exit 0 in both modes.** The CLI
read the file written by node-api 1.5.6 without trouble.

### 2.2 Problems in the existing set (8 files)

Five defects were found. Each was confirmed on the real data.

1. **No query could run as documented (all 8 files).** The README told users to run `.parameter set …`.
   DuckDB's CLI has no such command (that is the SQLite shell's), so the CLI answers
   `Unknown Command Error:
   Unrecognized command 'parameter'`. A bare `$start_ts` placeholder fails with
   "Prepared statement parameters cannot be used directly".
   - **Fix:** every file now uses `getvariable('…')`, set with `-cmd "SET VARIABLE …"`.
   - Time bounds are optional: an unset bound means unbounded, through `coalesce(…, '-infinity'/'infinity')`.
   - `$limit` became `row_limit`, because `limit` is reserved and `SET VARIABLE limit` is a parse error.
2. **`error-breakdown.sql` and `recent-errors.sql` used the wrong error test (stale).** They counted
   `outcome = 'error'`. On real data that matches **1** row, while `error_tag IS NOT NULL` matches **180**. A
   failed transaction is `outcome = 'rollback'` with its tag set. Only sql, backup and ingest records use
   outcome `error`.
   - **Fix:** errors are now `error_tag IS NOT NULL`.
   - `error-breakdown` also groups by role, kind, outcome and app.
   - `recent-errors` also includes warn/error-level rows without a tag: queue drops and `Effect.logWarning`.
3. **`trace-timeline.sql` listed every sql, tx and http event twice.** It unioned `platform_events` with the
   typed tables, but every record lands in `platform_events` _and_ in its typed table
   (`platform/eventlog/tables.ts`). Across all traces that union returns **7473 rows for 3793 events**.
   - **Fix:** `platform_events` is the backbone. `sql_text` is borrowed through a join on
     `(trace_id, ts, statement_kind, duration_ms)`; on this data that join is unique, with 2559 distinct keys
     for 2559 rows. `k6_points` is still unioned, because the event-log ingest never fills it.
4. **`log-level-distribution.sql` failed on a single malformed line.** It stopped with
   `Malformed JSON … line
   361`, the injected torn write.
   - **Fix:** it now passes `ignore_errors = true` and an explicit `columns` list. It groups by role.
   - Its counts now match `platform_events` exactly, plus the 3 rejected lines.
5. **The headers and README were stale.** They said "PLANNED SCHEMA, items 21-23 not yet landed" (item 21 has
   landed). They also named the database `logs/duckdb/events.duckdb`, but the real default is
   `<DATA_DIR>/eventlog.duckdb` (`platform/config.ts`, `EVENTLOG_DUCKDB`).
   - **Fix:** the headers and README were rewritten against `core/eventlog/ddl.ts` and `tables.ts`.

Smaller changes made at the same time:

- `backup-durations.sql`:
  - splits `put-object` by what was written (snapshot, manifest, `latest.json`); `ObjectStore` emits one
    `put-object` per PUT, three per run;
  - fixes the gap subquery so it runs once per app, not once per row.
- `lifecycle-events.sql` excludes `phase = 'log'`. Effect `log*` lines are ingested as lifecycle records and
  buried the real phases.
- `event-counts-by-type.sql` adds `role`.
- `slowest-sql.sql` changed only its variables. Its SQL was already correct.

### 2.3 Added (6 files)

Each one fills a gap left by a landed feature or a plan §4.3 named query, so item 23 can lift the SQL.

| File                            | Why                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tx-outcomes.sql`               | Plan `tx-outcomes`. Shows writer rollbacks run at about 30% under this workload (RuleError 10%, Conflict 9%, NotFound 9%), against about 1% on the reader. |
| `plan-shapes.sql`               | Plan `plan-shapes`. Distinct compiled SQL with latency and rows. It surfaced the reader point-lookup cost (finding 9).                                     |
| `mutation-vs-query-latency.sql` | Plan `mutation-vs-query-latency`, using `tx_events` by engine until http events exist. Writer p50 5.3 ms / p95 9.4 ms; reader p50 7.5 ms / p95 11.9 ms.    |
| `queue-depth.sql`               | Plan `queue-depth`. Recovers role and pid by joining `platform_events` (finding 5). Real drops: server 820, reader 40 at cap 64.                           |
| `ingest-health.sql`             | Item 21: per-file bytes, rows, rejected lines, rewrites and last movement. Shows the 3 quarantined lines against the right file.                           |
| `trace-summary.sql`             | Finds the trace ids to feed `trace-timeline` and labels each one request, process or fiber-fallback. It exposed the trace-id collision in finding 2.       |

Plan queries **not** written, because there is no data to check them against:

- `error-rate-by-handler` and `handler-throughput` need http/handler events (item 22).
- `k6-vs-platform` needs `perf:ingest` (item 25).

**Multitenancy:** there is no tenant code on `main`; only `docs/plans/multitenancy.md` exists. So there are no
tenant events and no tenant queries.

## 3. Verdict: not good to go — 3 high, 4 medium, 4 low

The core is in good shape:

- 412 tests pass;
- ingest is exactly-once and idempotent on real data;
- quarantine works;
- writer `traceId` propagation works when a caller annotates it (checked with a probe).

The observability layer cannot yet answer the questions the plan's catalog asks, though. Items 22 and 23 are
the natural owners of most of the fixes below. Each fix should become a plan item, not an ad-hoc edit.

### High

1. **No trace crosses the process boundary, and no plan item owns that.**
   - `ReaderRequest` / `ReaderRequestFrame` (`platform/services.ts:106-122`) has no trace-id field.
   - So `platform/reader.ts:208-209` stamps its own `reader-<pid>-<frame id>`.
   - Result: a server request's trace can never include the reader-side sql/tx it caused. The plan's `trace`
     query, "the complete ordered event timeline for one `trace_id` across both processes" (§4.3), and item
     28's trace-id walkthrough cannot be met.
   - **Fix:** add an optional `traceId` (and `spanId`) to the query/analysis frames. `reader.ts` uses it in
     `annotateLogs` when present. `ReaderClientLive` fills it from the caller's annotations. Add a property
     that a traced query's reader events carry the caller's trace id.
2. **The trace-id fallback collides across processes.**
   - With no `traceId` annotation, events fall back to `FiberId.threadName` (`platform/sqlite.ts:203`,
     `platform/logging/logger.ts:237`).
   - On real data `#2` holds **2602 events from 3 different writer processes** and spans 2 minutes. Fiber ids
     restart per process.
   - Item 22 will annotate HTTP requests, but the backup timer, startup and any un-annotated path will keep
     merging.
   - **Fix:** fall back to a per-process unique id (for example `fiber-<pid>-<fiberId>`), or require the
     annotation at the `Storage.mutation` boundary.
   - `trace-summary.sql` flags these ids meanwhile.
3. **CI is red on `main`.** `fmt:check` fails on `AGENTS.md` and `docs/plans/multitenancy.md` (§1). Both were
   docs commits that skipped `deno task fmt:check`. **Fix:** run `deno fmt` on the two files, and make
   `fmt:check` part of the docs-only commit checklist.

### Medium

4. **Backup and audit events are dropped first under load, just like SQL trace noise.**
   - `Queue.dropping` in `platform/logging/logger.ts` has one lane.
   - In the run capped at 64, the server dropped 820 events. `backup-durations.sql` then shows the JSON app
     with **5 `hash` but 4 `snapshot`/`verify` rows**: whole backup phases vanished from the audit trail.
     `TRACE_SQL` volume pushes out backup and lifecycle records.
   - **Fix:** a second small lane, or no-drop, for `warn`+ and the `backup`/`lifecycle`/`ingest` kinds. Then
     add a property that, under any burst, every non-trace event is either written or counted in a `dropped`
     report.
5. **The typed tables cannot be joined back to `platform_events`.**
   - The typed tables in `core/eventlog/ddl.ts` have no `event_id`.
   - `queue_events` also has no role or pid, and `backup_events` has no `trace_id`.
   - Every query needing both sides joins on heuristics (`queue-depth.sql`, `trace-timeline.sql`). Two
     processes reporting the same queue event in the same millisecond would fan out.
   - **Fix:** add `event_id` to every typed table, and `role`/`pid` to `queue_events`. The JSONL tree is the
     source of truth, so this is "drop the file and re-ingest". Update the §4.1 DDL in the plan to match.
6. **The SQLite and DuckDB paths never execute the same plan against the same data in a property test.**
   - `tests/property/compiler_test.ts:478` compares SQL _text_ skeletons across dialects.
   - `sqlite_oracle_test.ts` executes on SQLite only.
   - Read-after-write result parity between writer and reader is checked only by `tests/integration.ts`'s
     handful of cases. That parity is the platform's core promise.
   - **Fix:** a property that, for random docs and plans, has SQLite execution and DuckDB-over-attached-SQLite
     execution return equal rows, in both layouts. It would also pin down the 2^53 json issue (oracle 1a/1b)
     on the reader side.
7. **Config and plan drift.**
   - The event-log database default is `<DATA_DIR>/eventlog.duckdb` (`platform/config.ts`,
     `eventlogDuckdbPath`), but plan §4.1/§4.2 say `logs/duckdb/events.duckdb`.
   - Log retention defaults are 30 days / gzip after 7 / 1 GiB (`platform/config.ts` `logRetentionDays`,
     `logGzipAfterDays`, `logMaxTotalBytes`), against plan §4.2's 14 / 2 / 2 GiB.
   - The README options table is protected by `tests/unit/config_test.ts:255`. The plan is not.
   - Also:
     - `deno.json` declares `logs:ingest`, `logs:query` and `logs:sweep` over a `scripts/logs.ts` that does
       not exist (item 23).
     - The reader's `ingest` request is still a stub returning `IngestError("not available")`
       (`platform/reader.ts:172-176`), although `EventLogIngestLive` has landed.
     - `deno task check` still does not reach `platform/eventlog/*` (noted in `ingest.ts` Follow-ups).
   - **Fix:** item 22 wires `ingest` and the check graph. A plan erratum fixes the §4.1/§4.2 defaults and
     path.

### Low

8. **Event levels are inconsistent.** The same domain failure (SchemaError rollback) is `info` on the writer
   (`platform/sqlite.ts:337`) and `warn` on the reader (`platform/duckdb.ts:336`), so the
   `log-level-distribution` and `recent-errors` views get skewed. Pick one policy: an expected handler failure
   is `info`, and `warn` is for interrupted or failed infrastructure.
9. **Reader point lookups are 35 times slower than the writer.**
   - `plan-shapes.sql`: the same `SELECT * … WHERE "_id" = ?` takes p50 **5.2 ms on DuckDB** against **0.15 ms
     on SQLite**. The DuckDB-over-sqlite-scanner cost dominates every `getGame`.
   - This is not a bug, but it is the measured price of the reader split.
   - Worth a plan note before perf items 25+ set latency targets, perhaps routing by-id gets differently.
10. **Durations have millisecond resolution in backups and the object store.**
    - `platform/backup.ts:221,247,273` and `platform/object_store.ts:105-107` time with
      `Clock.currentTimeMillis`.
    - So backup phases record whole milliseconds (1.0, 2.0) and sub-millisecond phases read 0 or 1.
    - sql/tx use nanos. **Fix:** use `currentTimeNanos`, as `sqlite.ts` does.
11. **Log noise and misleading tags.**
    - Every remote reader error also logs a debug "Fiber terminated with an unhandled error". The cause is the
      `forkDaemon`'d wait in `platform/ipc.ts:458`, whose failure Effect reports before the join rethrows it.
    - A clean reader exit (code 0) is recorded as `reader-exited` with `errorTag: ReaderExitedError`
      (`platform/ipc.ts:244`).
    - `TRACE_SQL` only changes the level of sql events (`platform/sqlite.ts:252`, debug against info). It does
      not switch emission on, so `LOG_LEVEL=debug` writes every statement anyway, which contradicts the option
      description "Emit an event for every compiled SQL statement".
    - `platform/registry.ts` still reads `Deno.env` directly, and its `trace()` honours only `TRACE_SQL=1`,
      not the `true`/`yes` that `Config` accepts. Item 26 owns that.

### Invariants the property suites should cover but don't

In priority order:

- **Writer/reader result parity** (finding 6).
- **Cross-process trace continuity**, once finding 1 lands.
- **Event-record round trip:** for arbitrary `core/events.ts` records, `toJsonLine` → ingest → row reproduces
  the envelope and kind-specific columns, and the typed-table count per kind equals `platform_events`' count
  per kind. Today the mapping is example-tested only, at `tests/unit/eventlog_test.ts:331`.
- **Sink accounting:** written + Σ`dropped` = emitted, for any burst and capacity. Today this is
  example-tested only, at `tests/unit/logger_test.ts:371`.
- **Backup fault matrix:** for a failure at each phase, `latest.json` is unchanged and exactly one event is
  emitted per phase reached. Today this is example-tested per phase in `tests/unit/backup_test.ts:311-381`.

### Evidence that does support the current design

- **Ingest is exactly-once on real data.** The repeat runs inserted 0 rows. The 3 malformed lines were
  quarantined with the right reasons (`invalid-ts`, `invalid-json`, `missing-event-id`) and one
  `RejectedLines` event. `_ingest_state` matches the file sizes.
- **The writer queue behaves.** `queue_wait_ms` p95 is at most 0.19 ms per app. No `writer` or `reader` queue
  rejections occurred.
- **Backups are complete when events are not dropped.** Every successful run emitted its eight phases in the
  documented order under one trace id, and the bytes from `hash` equal the bytes from the snapshot
  `put-object`.
- **Effect-native error typing reaches the log.** Every rollback carries a tagged `error_tag` and a structured
  `attrs`, and no `Defect` tags appeared.
