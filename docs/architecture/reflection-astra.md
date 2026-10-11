# Reflection pass — Astra

## Ground truth

Reviewed on 2026-10-11 in `/root/Software/tsdb-work/rastra`, branch `reflection/astra`. Both HEAD and the
local origin/main reference resolved to `d6e08cd9babe0af09c62d2067d59b41749292ebd`. The worktree was clean at
the start. This review uses that fixed landed snapshot; it does not include another builder's item-22 worktree
or claim that the remote branch remained stationary afterward. No commits, merges or pushes were made.

Verified the plan's item boundaries against the source tree and history:

| Landed items             | Evidence in the snapshot                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01–03                    | Dependency pins/tasks; `core/errors.ts`, `platform/services.ts`; `perf/smoke.js`                                                                  |
| 04–08                    | Pure schema, framing, rotation and event modules; `platform/config.ts`                                                                            |
| 09–10                    | `core/compile/*`; Effect SDK and application handlers in `sdk/*`, `app/functions.ts`                                                              |
| 11–14                    | `platform/logging/*`; both property-test waves; k6 load scenarios                                                                                 |
| 15–18                    | `platform/sqlite.ts`, `duckdb.ts`, `reader.ts`, `ipc.ts`, `object_store.ts`                                                                       |
| 19–21                    | `platform/backup.ts`, `tests/layers/*`, `core/eventlog/*`, `platform/eventlog/*`                                                                  |
| Property/seed follow-ups | `tests/property/storage_commit_test.ts`, offsets commit-path properties and shared seed harness; history includes `60341ce`, `df4022f`, `4e9f9ba` |

**Item 22 has not landed.** `platform/server.ts` still constructs SQLiteWriter, ReaderRPC and Backups facades;
`platform/http/*` and `platform/layers.ts` are absent. These facades reuse landed Effect internals; it would
be wrong to say those implementations run only in tests. In particular objectStore() already builds
ObjectStoreLive with ConfigLive, while server.ts and registry.ts retain direct environment reads.

**Item 21 is a built library, not a connected runtime ingest path.** `platform/reader.ts:179` still answers
ingest with `IngestError: event-log ingest is not available`. Its ReaderProcessLive mounts
logging/configuration, not EventLogIngestLive. Analysis answers UnknownAnalysisQuery.
`platform/analysis/catalog.ts`, `scripts/logs.ts`, `platform/logging/retention.ts` and `perf/ingest_k6.ts` are
absent. Declared tasks are not proof their implementations exist.

**MT-01 through MT-09 remain planned.** `platform/registry.ts` registers two static app IDs and two SQLite
files. There is no landed tenant registry/router, Postgres control plane or end-user identity. The
deployment's object-store service is SeaweedFS; the existing local service was healthy and used for S3 tests
without changing its configuration.

All repository edits are restricted to the permitted diagram files/sources, `scripts/duckdb/*` and this
report. Product code, tests, plans and configuration were not changed. Temporary execution artifacts are under
`/tmp/reflection-astra-evidence/`; they are local evidence, not permanent repository assets.

## Phase 1 findings — diagrams

Reviewed every existing C4 pair against the actual entrypoints, service implementations, compatibility
facades, configuration, event DDL/mappings, SDK and perf scripts. Regeneration initially passed despite
semantic drift: a current embed does not prove a current architecture.

| Diagram pair                 | Drift found and corrected in both formats                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c4-context-document-db`     | Operator was marked planned despite a working backup endpoint. DuckDB consumption was marked planned despite the landed ingest library. Replaced target-state claims with explicit manual ingest, current HTTP transport and the missing trace propagation boundary.                                                  |
| `c4-container-platform`      | Distinguished live ReaderRPC/SQLiteWriter facades from the future layer composition. Preserved the real two-process native-library boundary, read-only live-file queries, queued snapshots and ordered uploads. Moved the caller SDK outside the host boundary.                                                       |
| `c4-container-observability` | Removed claims that both processes write JSONL, the reader already runs ingest, and the server runs retention. Removed nonexistent CLI/k6-ingest edges. Added actual stderr output and an explicitly manual ingest caller. Corrected “only DuckDB handle”: app-reader and event-log connections are separate handles. |
| `c4-component-server`        | Replaced the future PlatformLive/HTTP/AppRegistry dependency graph with the current dispatch, registry function and compatibility facades. Corrected “Config is the only environment reader” and “landed layers are exercised only by tests.” Shows real dependencies and external stores/processes.                  |

Updated all four `docs/architecture/diagrams/c4-*.py` sources and regenerated all terminal embeds. The two
formats have matching explanatory prose and identical numbered relationship sets: 6 context, 5 request-path, 6
observability and 14 server-component relationships. Terminal boxes describe the same nodes/boundaries; their
relationship keys carry edges without forcing crossing connectors into 72 columns.

Validation: `python3 docs/architecture/diagrams/render.py --check` passes. Checked generated terminal text and
enforced the 72-column limit; mechanically compared the relationship keys with Mermaid edge numbers. Mermaid
source was reviewed, but no browser-rendered screenshot validation was performed.

The out-of-scope `docs/architecture/README.md` still describes target architecture and stale item status;
`docs/architecture/AGENTS.md` also instructs authors to draw the target. They were not edited because the
user's allowed paths exclude them. This report and the revised diagram headers explicitly identify the
current-state interpretation.

## Phase 2 results — tests

Deno 2.9.5, repository-pinned dependencies, property seed **20261010**. Tests were executed before the query
phase. LOG_DIR was redirected to temporary directories. No test failures were fixed.

| Invocation                                                                                              | Passed | Failed | Skipped/ignored | Result                                                                              |
| ------------------------------------------------------------------------------------------------------- | -----: | -----: | --------------: | ----------------------------------------------------------------------------------- |
| `deno task test`                                                                                        |    349 |      0 |               1 | Passed; 46 seconds                                                                  |
| `deno task test:prop`                                                                                   |     63 |      0 |               3 | Passed; 1 minute 31 seconds                                                         |
| `S3_INTEGRATION=1 … deno test -A tests/integration/object_store_s3_test.ts`                             |      9 |      0 |               0 | Passed against existing local SeaweedFS                                             |
| `S3_INTEGRATION=1 … deno test -A --filter 'real S3: backup' tests/unit/backup_test.ts`                  |      1 |      0 |               0 | Passed; executes the unit suite's skipped backup case; 18 other cases filtered out  |
| `ORACLE_KNOWN_ISSUES=1 deno test -A --filter 'oracle known issue' tests/property/sqlite_oracle_test.ts` |      0 |      3 |               0 | Reproduced all three documented known issues; one ordinary oracle case filtered out |

The default unit/property total is **412 passed / 0 failed / 4 skipped**. After executing the gated cases and
the separate S3 suite, the unique test-case total is **422 passed / 3 failed / 0 left unexecuted**. Do not add
the initial skips to the final unique-case total. An initial ungated S3 discovery run reported 0 passed / 0
failed / 9 ignored; the enabled run above supersedes it.

`deno task integration` is an assertion-based script, not a counted test suite. It exited 0 and printed:
“PASS: both layouts, DuckDB read-after-write, aggregation, app isolation, backup, restore, HTTP auth.” It is
reported separately rather than inventing a test-case count. The first sandbox attempt could not open its
loopback socket (`tests/integration.ts:12`, PermissionDenied); the authorized host rerun passed.
`deno task check` also passed. This is not a claim that the full `deno task ci` command was run.

Reproduced failures, all in `tests/property/sqlite_oracle_test.ts`:

1. **Line 274, known issue 1a:** JSON-layout equality against an integral double beyond 2^53 returns `[]`
   instead of the inserted row. The assertion fails at line 284. `core/compile/select.ts:84` uses bare SQLite
   json_extract, which can interpret the JSON decimal as an exact integer rather than the original JavaScript
   double.
2. **Line 293, known issue 1b:** JSON-layout countBy at 2^53 throws
   `RangeError: Value is too large to be represented as a JavaScript number: 9007199254740992` at the
   node:sqlite read (`runOne`, line 265), before decoding. Same numeric-expression boundary.
3. **Line 308, known issue 2:** column-layout text `a\u0000b` reads back as `a`; assertion fails at line 314.
   This is the node:sqlite TEXT-return boundary, not an event-log ingest failure.

Logs: `unit.log`, `property.log`, `integration.log`, `s3-live.log`, `backup-s3.log`, `oracle-known.log` and
`check.log` in the evidence directory. These are existing opted-in regression failures, not regressions
introduced by the reflection edits.

## Phase 3 findings — queries

### Real data and ingestion

Used two sources of real emitted events, without manufacturing fixture rows or inserting directly into event
tables:

1. The successful HTTP integration run with TRACE_SQL=1 produced **42 reader JSONL events**, 18,492 bytes: 19
   SQL, 19 transactions and 4 lifecycle/log records.
2. A separate scratch process explicitly composed ConfigTest, LoggingLive, IdGenLive, ObjectStoreLocal,
   makeStorage and makeBackupRunner. It created a real SQLite game, attempted a move with version 999 (actual
   version 1, yielding ConflictError), and took a real 32,768-byte snapshot into a temporary local object
   store. This produced **24 additional events**, 11,766 bytes. This exercises landed services; it does not
   imply that the unported HTTP server mounts LoggingLive.

A separate process composed makeEventLogIngest into scoped runs targeting
`/tmp/reflection-astra-evidence/events.duckdb`. Initial ingest inserted 42 lines, and a repeat inserted 0.
After the live-service run, incremental ingest inserted 24 lines, and a repeat again inserted 0. There were
**0 rejected lines**. Both unchanged repeats left event counts unchanged.

Final table counts:

| Table            | Rows |
| ---------------- | ---: |
| platform_events  |   66 |
| sql_events       |   32 |
| tx_events        |   22 |
| backup_events    |    8 |
| lifecycle_events |    4 |
| http_events      |    0 |
| queue_events     |    0 |
| k6_points        |    0 |
| _ingest_state    |    2 |

Typed tables project canonical events; these counts must not be summed as independent events. Empty HTTP and
k6 tables reflect missing runtime producers. The small run did not saturate queues. All records were
info-level, including the ConflictError rollback: log level alone would miss that failure.

### Queries executed and corrected

Ran all eight original queries against the real database after adapting only parameter binding for the
comparison, then all ten final queries. Final queries pass in **DuckDB CLI 1.5.5** and the repository's
**@duckdb/node-api / DuckDB 1.5.6** driver. The comparison window was UTC
`[2026-10-11 00:00:00, 2026-10-12 00:00:00)`.

| Query                      | Final result                                             | Change/evidence                                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| event-counts-by-type       | 15 groups, summing to 66 events                          | Corrected handler-kind interpretation: ingest maps handler to query/mutation. Normalizes event_kind and exposes handler_kind separately. No handler producer was exercised in this run; this mapping correction is supported by source inspection.                                                 |
| error-breakdown            | 1 ConflictError; 100% of failures, 1.52% of all events   | Old outcome='error' predicate returned zero despite a real conflict rollback. Now includes error tags, error-level logs and error/rollback/interrupted outcomes.                                                                                                                                   |
| recent-errors              | 1 rollback record with actual=1, expected=999 in attrs   | Same failure predicate correction; documented actual errorDetail/lifecycle.detail mapping.                                                                                                                                                                                                         |
| log-level-distribution     | 66 info events, 100%                                     | Explicit level projection and union-by-name for mixed JSONL shapes; removed claim that ingest is unavailable.                                                                                                                                                                                      |
| slowest-sql                | 9 engine/statement/table groups                          | Executed against both SQLite and DuckDB records; corrected landed-schema and exclusive-end documentation.                                                                                                                                                                                          |
| backup-durations           | 6 phase groups from 8 records                            | Documented duplicate put-object emitters and in-window completion gaps. One backup means average gap is NULL, correctly.                                                                                                                                                                           |
| lifecycle-events           | 4 ordered phases/log records                             | Verified real reader output; corrected schema/bounds documentation.                                                                                                                                                                                                                                |
| trace-timeline             | 3 canonical events for reader-2539718-3                  | Original query fails with “Malformed JSON” while casting sql_text to extra: the k6 tags JSON branch controls UNION coercion, even with no k6 rows. Replaced the union with canonical events, avoiding typed-table duplicates and including lifecycle/backup/queue events when their trace matches. |
| transaction-outcomes (new) | 4 groups: 21 commits, 1 rollback                         | Exposes actual commit/rollback/interrupted taxonomy and queue-wait/transaction p95.                                                                                                                                                                                                                |
| ingest-coverage (new)      | 2 source rows; 30,258 ingested bytes, 66 accepted events | Reports source offsets, timestamps and sticky-dedupe state; explicitly does not claim filesystem backlog measurement.                                                                                                                                                                              |

Replaced unsupported `.parameter set` instructions with verified `SET VARIABLE` / `getvariable()` calls in all
query files and the README. Used row_limit instead of the reserved keyword limit. Corrected the README's
claims that DuckDB/ingest were unavailable, distinguished the absent item-23 catalog, documented the manual
ingest boundary, and ran its shell examples successfully. An unset variable can silently yield NULL/empty
results; every example sets its required variables.

The canonical trace intentionally does not expose typed-only SQL text: typed tables lack event_id, so an exact
general join is not available. k6 metrics are excluded rather than mislabeled duration_ms; different metrics
have different units and their producer has not landed. Current trace IDs are reader-local, not proof of
end-to-end HTTP tracing.

Evidence: `ingest.log`, `ingest-expanded.log`, `live-events.log`, `queries-final.log`, `driver-queries.log`,
per-query before/after JSON and `readme-examples.log` in the evidence directory. The scratch
ingest/live-service/query harnesses are there as well. No item-23 catalog existed to execute.

## Phase 4 verdict — prioritized improvements

**Keep the core design and continue the port, but do not declare the whole platform production-ready.** The
pure compiler/service separation, native-library process boundary, serialized mutation transactions,
snapshot-before-upload flow and transactional event-ingest offsets are supported by passing unit, property,
HTTP integration and real S3 evidence. Three opted-in regressions reproduce real data-semantics bugs, while
server composition and operational observability remain incomplete. The following should become tracked plan
work; no corresponding code fixes were made in this pass.

| Priority | Improvement and concrete paths                                                                                                                                                                                                                                                                                                                                                       | Acceptance evidence needed                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Fix SQLite JSON number semantics in `core/compile/select.ts:74`–84, with coverage in `tests/property/sqlite_oracle_test.ts`. Schema-declared number expressions need consistent real-number semantics for filtering, grouping and ordering; retain integer semantics separately.                                                                                                     | Both large-number regressions pass; compare JSON/columns layouts and SQLite/DuckDB for boundary values.                                                                                                 |
| P1       | Resolve or explicitly reject embedded-NUL text at the storage contract: `platform/sqlite.ts` driver reads, `core/schema.ts` accepted strings, and `tests/property/sqlite_oracle_test.ts:308`. Choose lossless driver behavior or typed rejection; do not silently truncate accepted data.                                                                                            | NUL round trips or is rejected before commit; cover scalar fields and identifiers with real storage, not only test doubles.                                                                             |
| P1       | Complete item 22's scoped server composition in `platform/server.ts`, `platform/registry.ts`, and the planned `platform/layers.ts`/`platform/http/*`. Startup currently opens writers and a child before later configuration/serve steps; shutdown is manual. Mount real logging, centralize environment reads and use typed HTTP error mapping instead of blanket caught-error 400. | Exercise partial-startup failure, in-flight shutdown, HTTP status classes and server event emission. Distinguish source-inspected lifetime exposure from an observed leak: no leak was reproduced here. |
| P1       | Wire EventLogIngestLive into `platform/reader.ts:179` and its layer composition. Keep DuckDB outside the writer server. Retain scoped handles and serialize access as designed.                                                                                                                                                                                                      | A real ingest RPC succeeds, a second unchanged call inserts zero, restart preserves offsets, and the public check graph reaches eventlog modules through an entrypoint.                                 |
| P1       | Carry trace context end-to-end through `sdk/client.ts`, `platform/server.ts`, `platform/services.ts:106`, `platform/ipc.ts` and `platform/reader.ts:208`. The wire request has no trace field; the reader substitutes reader-pid-request.                                                                                                                                            | One caller trace identifies HTTP, handler, SQL and transaction events across both processes and is echoed by HTTP; correlate to k6 only after its producer lands.                                       |
| P2       | Make event identity and taxonomy easier to query in `core/eventlog/ddl.ts`, `platform/eventlog/tables.ts` and future `platform/analysis/catalog.ts`. Typed projections lack event_id; canonical kind overloads event type with handler kind. ObjectStore/Backups phase records cannot always identify their emitter/run without ambiguity.                                           | Explicit canonical event_kind and handler_kind, exact typed-to-canonical joins, and unambiguous backup phase/transfer accounting, with a migration/rebuild strategy before schema changes.              |
| P2       | Deliver item-24 retention with ingest ordering around `platform/eventlog/ingest.ts`, `core/logging/rotation.ts` and planned `platform/logging/retention.ts`. Preserve the documented ingest-before-gzip condition; define disk-growth/retention expectations for the derived DuckDB file.                                                                                            | Demonstrate that rotation/sweep cannot hide an un-ingested tail, account for logger drops, and measure disk behavior under sustained load. This small run is not a capacity benchmark.                  |
| P2       | Reconcile `docs/architecture/README.md`, `docs/architecture/AGENTS.md` and root `README.md` with landed status. The architecture index still calls item 21 planned; root README retains an obsolete untested-environment caveat. Consider a reader-component diagram after composition lands.                                                                                        | Documentation distinguishes current runtime, available libraries and future targets; validate both diagram formats against each landed change. These files were outside the edit allowlist.             |

Multitenancy remains future work, not a missing promise of this single-deployment MVP. Re-run this reflection
at the next architectural transition, after item 22 and the analysis/retention integration land, before using
these results as evidence for tenant isolation or production operations.
