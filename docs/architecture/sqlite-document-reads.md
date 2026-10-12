# SQLite document-read verification (SP-06)

Initial verification: 2026-10-11 UTC. Follow-up verification: 2026-10-12 UTC. Branch: `sp/06-verification`.
Product baseline: `dc768137bfe647c55f51a61647d986c1a263cb83` (SP-02 and SP-05 landed).

## Scope and execution paths

SP-02 routes document query handlers through in-process SQLite. In `platform/document_reader.ts`,
`makeDocumentReaderClient` decorates only requests whose kind is `query`; every other request is passed
straight to the original supervised IPC client. The server installs this decorator in `platform/layers.ts`.
Document reads use scoped, read-only SQLite handles and emit server-side SQLite SQL/transaction events. SP-05
adds the execution semaphore and preserves the admission limit and deadline. Mutations continue to use the
existing SQLite writer.

Event-log ingest and named analysis queries are untouched by the pivot. `ingest` and `analysis` requests still
travel through the supervised reader client, across IPC, into `platform/reader.ts`. Its dispatch calls
`eventLog.ingest` and `analysis.run`, respectively. The reader owns the event-log DuckDB handle;
`platform/analysis/catalog.ts` executes the fixed named SQL catalog against that DuckDB event log. SQLite
document-query execution does not execute the analysis catalog. The SQL events _being analyzed_ can identify
SQLite as their engine without changing the analysis engine, which remains DuckDB.

A document-only trace now contains server-role events. It need not contain a reader-role event. The catalog's
existing `mutation-vs-query-latency` output retains its historical `reader` label for queries; that label
describes handler kind, not the physical engine or process after this pivot.

## Supervision test corrections

The two authorized tests in `tests/unit/server_scope_test.ts` are changed. Both formerly expected one reader
death to terminate the server with `ReaderExitedError`. Since `cd669d1`, the supervisor restarts the reader,
with backoff, and abandons supervision only after more than five attempts within ten minutes.

The in-process test kills the reader, requires `reader-restarting` followed by `reader-restarted`, checks that
a newly logged PID is alive and differs from the killed child, and checks that `runServer` remains pending. It
then requests `test-stop`, requires an interrupted normal shutdown, checks `SHUTDOWN_ORDER` from the stopping
event, and verifies that the replacement is gone. The killed child's earlier `reader-exited` event is
deliberately excluded from the normal shutdown order assertion.

The process test checks the same event pair and replacement PID, observes the full former 15-second failure
bound without server exit, then sends SIGTERM. It requires exit 0 within 15 seconds, no `ReaderExitedError`
failure on stderr, normal finalizer order, and release of the replacement process.

## Verification matrix

The gate commit on `sp/06-verification` includes both supervision corrections, the third stale-expectation
correction, and this report. Product code remains at `dc76813`. Final suite results refer to that identical
product/test tree; the gate commit is identified by the branch and commit subject rather than a
self-referential hash inside this report.

| Suite / command                                             | Result                                                    | Product commit                      |
| ----------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| `deno task ci`: format, lint, type checks                   | PASS (238 formatted files, 151 linted files)              | SP-06 gate commit                   |
| `deno task ci`: unit/core/conformance                       | 611 passed, 0 failed, 1 ignored                           | SP-06 gate commit                   |
| `deno task ci`: property tests                              | 79 passed, 0 failed                                       | SP-06 gate commit                   |
| Separate `deno task test:prop`, seed `20261010`             | 79 passed, 0 failed                                       | `dc76813` + supervision corrections |
| Final supervision-only replay via `deno task test --filter` | 2 passed, 0 failed                                        | `dc76813` + supervision corrections |
| `PROP_SEED=20261010 deno task e2e`                          | 7 passed, 0 failed; 7 scenarios, none skipped             | SP-06 gate commit                   |
| `PROP_SEED=20261011 deno task e2e`                          | 7 passed, 0 failed; 7 scenarios, none skipped             | SP-06 gate commit                   |
| `deno task integration`                                     | PASS (one integration program)                            | `dc76813` + supervision corrections |
| `deno run -A tests/e2e/observability_test.ts`               | PASS (one smoke/ingest/join program, 4 populated buckets) | `dc76813` + supervision corrections |
| Live named analysis catalog                                 | 10/10 queries populated and checked                       | `dc76813`                           |

The existing storage conformance script passed for both columns and JSON layouts. The script now has 63
entries including its two clock ticks (the plan describes it as approximately 62 steps). This is the storage
implementation/double conformance check, not 63 HTTP document queries. The seven `document_reader_test.ts`
tests passed, including SQLite/DuckDB result parity for both layouts and legacy/API-key modes, no document IPC
calls, deadline cleanup, and execution/admission recovery. MT-10's dedicated document and query scenarios also
passed on both seeds.

The sole ignored unit case is the opt-in real-S3 backup round trip. Local-object-store backup and restore
checks ran and passed. An earlier overlapping `deno task test` run returned 610 passed, 1 failed, 1 ignored:
`ipc_test.ts`'s timed-out late-reply trace test failed with an `IpcError`. The same test passed unchanged in
the subsequent complete CI unit phase. This transient failure is recorded rather than hidden; no assertion was
weakened to resolve it.

## Third stale expectation: MT-10 trace ownership

The initial MT-10 runs were 6/7 on seeds `20261010` and `20261011`. The log-analysis scenario's `complete()`
required both server and reader roles under the trace attached to an HTTP `getGame`. That request has used
in-process SQLite since SP-02, so the missing reader-role event was a stale expectation, not an ingest
failure. The follow-up explicitly authorized this third test correction.

A tiny live experiment first sent traced, successful `handler-throughput` analysis and ingest requests,
verified their echoed `x-trace-id`, ingested the logs, and queried the trace catalog. Each caller trace
contained only its server HTTP record. Inspection of the reader's raw JSONL confirmed no reader events under
either caller ID. This matches the code: `makeAnalysis.run` executes DuckDB without emitting SQL/transaction
events; successful quiet ingest emits no ingest event; ingest anomalies and retention use their own trace IDs,
and `emitLifecycle` uses `reader-lifecycle`. `withRequestContext` propagates annotations but cannot create
events that those paths do not emit. Attaching a header to analysis alone would therefore preserve the
impossible expectation.

A second experiment used the supported direct reader-query RPC with the same presented trace ID as a
successful HTTP analysis call. The standalone reader returned the expected game ID, exited normally, and wrote
caller-traced DuckDB SQL/transaction events. After HTTP ingest, the catalog returned those reader events
alongside the server analysis HTTP event, in timestamp order. This establishes the actual emitted
cross-process trace behavior without changing product logging or request routing.

The scenario now uses that explicit protocol probe: one scoped, bounded standalone `platform/reader.ts`
process receives a direct `getGame` query frame, returns the expected ID, and flushes its real reader sink on
exit. A `handler-throughput` admin analysis request presents the same trace through `request()`'s extra
headers. `complete()` still requires both roles in that shared trace. These are separate requests sharing a
trace, not a claim that the analysis request emits reader SQL or that HTTP document reads reach a child. The
additional reader never runs event-log ingest/analysis or opens the persistent event-log handle; the server's
supervised reader remains its sole owner.

The normal HTTP document query has a distinct `${traceId}-document` ID. Its populated ingested trace must
contain server-role SQL and HTTP evidence and exactly the role set `{server}`. The shared trace must also
contain reader-role SQL from the direct RPC. Throughput handler coverage, error/tag pairs, nonempty slow-SQL
and transaction results, successful backup publication, ordered trace timestamps, unknown-query 404, and
frozen-snapshot CLI agreement remain intact. Only this scenario, the two supervision tests, and this report
change; no product behavior changes are made.

## Live event-log and analysis catalog

A fresh live server used both document layouts, isolated data/log/object-store/event-log paths, local object
storage, and debug logging. The workload comprised 80 pressure mutations with a one-record event queue (to
produce real drop reports), followed by normal-capacity logging; create/get/list/move/history calls for both
apps; one deliberate version conflict per app; and one successful backup per app. A real k6 run added 50
create/get pairs, with all 100 requests checked for success and returned IDs.

Document reads used in-process SQLite; mutations and backups used the existing writer/backup path.
`POST /admin/logs/ingest` ingested the real JSONL through IPC into reader-owned DuckDB. The first run accepted
470 records and the second accepted 38, with zero rejected lines. The second run reported 508 platform-event
rows. The pressure stage recorded 350 dropped events, explicitly accounted for in the queue reports rather
than claimed as ingested workload records.

For `k6-vs-platform`, the real k6 JSON output was loaded with the existing `ingestK6` helper while the server
was stopped, respecting DuckDB's single-owner file lock. It loaded 1,202 metric points into `k6_points` in the
same scratch event-log database. The server was restarted, and every query below ran through
`POST /admin/logs/analysis/:name` while the server was live. No analysis SQL ran in SQLite.

| Named query                 | Returned rows | Checked evidence                                                              |
| --------------------------- | ------------: | ----------------------------------------------------------------------------- |
| `slowest-sql`               |             8 | Positive calls; all observed SQL engine labels are SQLite.                    |
| `plan-shapes`               |            23 | Positive calls and nonnegative total-row counts for real compiled statements. |
| `error-rate-by-handler`     |            14 | `makeMove` errors include `ConflictError`.                                    |
| `mutation-vs-query-latency` |             2 | Both mutation and query distributions present.                                |
| `handler-throughput`        |            14 | Create/get/list/move/history handlers present.                                |
| `queue-depth`               |             2 | Real event-queue drops; totals sum to 350.                                    |
| `tx-outcomes`               |             4 | Commit and rollback outcomes, with both apps represented.                     |
| `backup-history`            |            12 | Successful `publish-latest` for both apps.                                    |
| `trace`                     |            83 | Ordered timeline with server-side SQL and `getGame` HTTP evidence.            |
| `k6-vs-platform`            |             1 | 100 client requests joined to a bucket with 115 server requests.              |

All ten results were non-vacuous and passed the checks above. The joined client/server p95 values were
24.629/24.532 ms; this shared-host workload is a catalog correctness check, not the document-read benchmark.
Scratch servers and their directories were reclaimed.

## Document-query benchmark

The comparison uses the unchanged pre-SP-02 commit `4c42d98` in a detached scratch worktree, rather than
pretending that a configuration switch restores the old path. That commit is the parent of the first SP-02
implementation commit (`35ca862`), and its server composition uses the supervised IPC reader directly, without
the document decorator. The new path is the SP-02/SP-05 baseline `dc76813`.

One identical Python HTTP workload ran against a fresh live server on each path, serially (SQLite first,
DuckDB second) after this builder's verification jobs completed. Each used 100 freshly created playing games
in the columns layout, legacy authentication, default logging, local object storage, and one persistent
loopback HTTP connection. It ran `getGame` against the 100 IDs cyclically and
`listGames({status: "playing"})`, which returns at most 20 documents. Every point-read ID and every query's 20
playing-game results were checked.

Per path: 2,000 measured requests per endpoint, plus 200 excluded warmup requests per endpoint: 4,000 measured
queries, 400 warmup queries, and 100 setup mutations. Measurement uses monotonic `perf_counter_ns`, beginning
before JSON request construction and ending after the complete HTTP response is read and JSON-decoded;
correctness assertions run outside the measured interval. Percentiles use the nearest rank in the sorted
samples (`ceil(p * N)`). These are end-to-end client latencies, including HTTP, serialization, handler
execution, and IPC where present; they are not isolated SQL-engine timings. Startup, initial extension
installation, and setup mutations are excluded.

| Path / product commit         | Endpoint    | Measured requests | p50 ms | p99 ms |
| ----------------------------- | ----------- | ----------------: | -----: | -----: |
| In-process SQLite / `dc76813` | `getGame`   |             2,000 |  4.103 | 12.525 |
| In-process SQLite / `dc76813` | `listGames` |             2,000 |  4.494 | 12.353 |
| DuckDB over IPC / `4c42d98`   | `getGame`   |             2,000 | 13.979 | 36.783 |
| DuckDB over IPC / `4c42d98`   | `listGames` |             2,000 | 14.029 | 27.938 |

Runtime: Deno 2.9.5 on the shared Linux VM. This is a single serial comparison, with no host isolation, order
randomization, concurrency stress, or confidence intervals. Other agents' activity can affect latency. The
benchmark has no pass threshold, and these numbers alone do not establish general throughput or an
engine-level speedup. Both servers and scratch data are stopped/reclaimed; the old worktree is checked clean
and removed after measurement.

## Gate verdict

**All builder verification checks pass.** The final full `deno task ci` run passed format, lint, and type
checks, 611 unit/core/conformance tests (zero failures, one opt-in real-S3 case ignored), and 79 property
tests (zero failures). MT-10 passed 7/7 on both seeds `20261010` and `20261011`, with no skips, no remaining
e2e containers, and the original catalog/CLI assertions intact. No test or product source changed after these
final runs; the final formatted report is committed with the tested tree.

The initial stale expectations and the transient initial IPC timeout remain documented above. Event-log
ingest/analysis stay on reader-owned DuckDB; production document reads stay in-process SQLite. The earlier
live catalog and benchmark evidence applies unchanged to the product baseline. The additional direct-reader
query is explicitly test-only protocol coverage.

This report belongs to `SP-06: verification gate (Sol build)` on `sp/06-verification`, together with exactly
the two supervision-test corrections and the third stale scenario correction. No product behavior changes or
merge to `main` are included. Final format, lint, type checks, and `git diff --check` pass.

**Formal acceptance remains subject to the independent reviewer explicitly stating that the gate is met.** The
builder's successful verification is evidence for that review, not a substitute for the required independent
verdict.
