# FFI-06 evidence and ownership handoff

2026-10-14 · sol-ffi-06 · item/ffi-06-evidence · base f2bf1c9.

Historical evidence from sol-ffi-06 is retained below. The coordinator authorized the additive companion
changes on 2026-10-14 and assigned fresh continuation actor sol-ffi-06-cont in this worktree. The proposed
patch was checked against the actual nine failures in test.log and applied: both documentation lists and
schema documentation now include the query/path, and the SQL fixture names its original fourteen columns. No
binding, frozen deno.json, FFI-07 file, knowledge file or other worktree is edited. Continuation validation
and final SHAs are recorded below when complete.

## Resolved ownership extension (historical proposal)

The apply-checked proposed-catalog-compat.patch contains exactly these compatibility updates:

- docs/observability.md: sql_events.path column and new named-query documentation/parameters.
- docs.md: one catalog-list description for the new query.
- tests/unit/analysis_catalog_test.ts: exact catalog-name assertion and an explicit column list for the
  existing SQL fixture, so nullable additions do not break its positional values.

The previous unit requested these companions and stopped without editing them. The coordinator event
2026-10-14T01-57-05Z-fable-ffi-coordinator and brief-continuation.md explicitly authorize these additive
edits. The continuation applied them only after inspecting the actual assertions and fixture failure.

## Previous-unit validation

| Task                                                      | Outcome                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| deno task lint                                            | PASS, 167 files                                                      |
| deno task check                                           | PASS                                                                 |
| Additional check: all three harnesses and migration probe | PASS                                                                 |
| deno task fmt:check                                       | PASS, 256 files                                                      |
| Explicit artifact-directory format check                  | PASS                                                                 |
| deno task test                                            | 677 passed, 9 failed, 1 ignored, 4m34s                               |
| deno task test:prop                                       | 79 passed, 0 failed, 2m24s                                           |
| deno task integration                                     | PASS, both original checks and new FFI-06 scenario                   |
| logs:ingest / logs:query                                  | PASS within integration, actual CLI processes                        |
| Old-v2 migration probe                                    | PASS, DDL applied twice, 165 SQL rows preserved with NULL paths      |
| deno task ci                                              | Not redundantly run; unit gate fails on the nine compatibility cases |

All nine unit failures are explained by the proposed patch: four catalog/documentation assertions, four
fixture setup failures (15 columns versus 14 positional values), and the guide's exact catalog list. No known
timing flake or native crash appeared in the accepted full run. The SQL event golden passes.

Before each suite the process list was checked. Two earlier unit starts were stopped when FFI-07 seed tests
were observed, including a race between its two sweeps; these partial runs are not accepted evidence. The
accepted full unit suite waited for 30 seconds continuously without a deno test process. Property and
integration runs followed sequentially. Harness rechecks started with no test process; an FFI-07 property
suite was present by the final process check, and all final interrupt/cap gates still passed.

## Harness numbers versus the PoC

Each read distribution has 20,000 calls, with separate node:sqlite and FFI WAL files. Timed intervals exclude
correctness assertions. The port uses the production Statement API; the original PoC called raw symbols. The
read file retains the PoC JSON keys and adds loadavg.

| Distribution         | Production final p50 / p99 | Committed research JSON p50 / p99 |
| -------------------- | -------------------------- | --------------------------------- |
| node:sqlite blocking | 8.28 / 34.65 µs            | 8.66 / 34.18 µs                   |
| FFI blocking         | 8.96 / 37.18 µs            | 6.35 / 27.77 µs                   |
| FFI nonblocking      | 49.52 / 419.00 µs          | 44.31 / 241.36 µs                 |

Read load 1/5/15: 1.84 / 2.08 / 2.78. FFI blocking passes the requested 10.2 µs PoC budget but **fails strict
same-run node parity** (8.96 > 8.28); the harness exits 1. Nonblocking gates pass. An earlier run also failed
strict parity (7.60 > 6.84 µs at load 1.38 / 1.35 / 1.39). No gate is relaxed.

Interrupt: 50 samples, p99 6.114 ms, every one-second window at least 92 ten-millisecond ticks, load 2.09 /
2.13 / 2.79; PASS. The research deno-ffi.json has a single 0.408 ms interrupt and 95 ticks, which is not a
50-sample tail statistic. The production probe aborts through the binding's signal bridge and waits for typed
SqliteCancelled after reset. A loaded earlier run had p99 6.293 ms but only 61 minimum ticks during concurrent
seed sweeps; that failed run is retained separately.

Cap: 32/32 reason=deadline SqliteCancelled failures, elapsed range 50.836–71.050 ms, load 2.09 / 2.13 / 2.79;
PASS against 100 ms. Each has a separate file/connection and all submissions occur in one main-thread turn
through Statement.allAsync(undefined, { timeoutMs: 50 }). An earlier passing direct run maxed at 66.243 ms,
load 4.21 / 2.31 / 1.72. An initial Effect-wrapped diagnostic reached 139.85 ms at load 1.35 and is retained
as cap-effect-diagnostic.json. It includes Effect orchestration, and the host conditions differed: these runs
do not isolate the cause of that delta. Do not interpret the native-pool result as a measured 32-request HTTP
latency guarantee.

The PoC branch is origin/research/fable-lang-switch. Its load.txt spans 3.30 → 4.93. Script index rows
identify the two PoCs as superseded without pretending they exist on main.

## Integration and operator CLI

The new scenario creates a private database on the dev Postgres, migrates it and creates two real API-key
tenants through HTTP. It initializes their files through the router, then seeds 500,000 JSON games on the big
tenant through the production binding. winsByMark's countBy is the long statement; getGame is a primary-key
read on the small tenant. Only the JSON app is used, respecting the one-schema fingerprint per tenant file.

Twenty separate count windows return HTTP 504 / StatementDeadlineError. Every point read begun while a
competing request is active is counted, including those finishing after that request. Final run: 153 point
reads, client p99 22.097452 ms, load 1.79 / 2.09 / 2.81, budget 50 ms (factor 1). The private Postgres
database is dropped on exit and successful scratch roots are removed.

After server shutdown the actual operator CLI ingested 762 lines with zero rejects:

```json
{
  "filesScanned": 2,
  "filesIngested": 2,
  "bytesIngested": 391324,
  "linesIngested": 762,
  "linesRejected": 0,
  "durationMs": 378.516802
}
```

logs:query deadline-hits-per-handler-hour --format json returned:

```json
[{
  "hour": "2026-10-14 01:00:00",
  "app_id": "tic-tac-toe-json",
  "handler_kind": "query",
  "name": "winsByMark",
  "path": "nonblocking",
  "deadline_hits": 20
}]
```

The scenario independently verifies those trace IDs in sql_events using a separate DuckDB subprocess. The new
catalog query picks at most one request per SQL event by trace, app and request time window (one millisecond
allowed for timestamp rounding), so reusing a trace across sequential handlers does not multiply counts. A
caught statement deadline can still be attributed to its successful HTTP handler. Ambiguous simultaneous
requests with identical caller-supplied trace/app IDs remain a trace-correlation limitation. Unmatched events
are preserved under NULL handler fields.

## Learning assessment and ownership-safe handoff

These project findings belong in docs/knowledge/, which this unit does not own. The coordinator should
authorize a fresh documentation unit to preserve them; no VM knowledge-store update is needed.

- New catalog entries require coordinated changes to both observability docs and the guide, plus the
  catalog-name test. Existing positional SQL fixtures need explicit columns when a nullable field is added.
- Persisting an event payload field needs KIND_KEYS as well as the typed DuckDB projection; the optional
  TypeScript field alone did not keep path in JSONL. Only the affected events golden line was changed.
- The additive nullable migration belongs after the v1/version guards and table creation. Existing v2 rows
  retain NULL; two full DDL applications succeeded without changing their count.
- The hardened production Statement's blocking p50 is below the absolute PoC budget but above the same-run
  node oracle in both runs. Deciding whether to change that gate or optimize the binding belongs to the
  coordinator and independent reviewer; binding edits are outside FFI-06 Owns.
- The pool measurement and the Effect-wrapped diagnostic measure different boundaries. Preserve both until a
  follow-up can explain the 139.85 ms diagnostic under controlled same-load conditions.
- Raw Database.interrupt alone produced SqliteError on the first diagnostic attempt. The production
  AbortSignal bridge records cancellation and yields SqliteCancelled; the final interrupt harness uses it.
- Shared test coordination has a gap between seed sweeps. A 30-second stable-idle check avoided the next
  transition race; a shared suite lock would be a separate protocol/script-owner improvement.

## Reviewer starting points

First inspect the strict node-parity gate and the continuation fairness changes/results. The ownership/CI
companion patch is now authorized and applied. Then inspect the cap's measurement boundary and the retained
Effect diagnostic, the real-tenant integration's overlapping read sampling, the request correlation in the
catalog, and finally KIND_KEYS/path DDL/projection together. No binding, frozen deno.json, FFI-07 file or
other worktree was edited. Main was not touched.

## Continuation harness fairness assessment

The synchronous path is the same Database.open / prepare / Statement.get API used by FFI-01's
sqlite_ffi_perf_test.ts. Both drivers retain one prepared SELECT body FROM docs WHERE id = ?, decode exactly
one TEXT column, and return one row from independent, identically seeded 1,000-row WAL files. Both receive the
same numeric values using their public API: node:sqlite is variadic, Statement takes an array. The
continuation precomputes and reuses each bind array, passing it to Statement and spreading it into node's
variadic method; there is no FFI-only array allocation inside the measured interval. It also precomputes the
expected TEXT and adds 2,000 excluded nonblocking warm-up calls. Both blocking paths still have 2,000 excluded
warm-ups and 20,000 timed calls in ten 2,000-call batches, alternating which driver runs first. Assertions,
reporting, and percentile sorting are outside the timed calls. No binding implementation or threshold changed.

FFI-01's tolerance (1.3× node + 1 µs) is a different gate from this item's strict <= node gate; passing the
former never counts as passing the latter. The original read measurements are retained as historical runs;
quiet-host continuation results will be reported separately without selecting only favorable runs.

The inherited interrupt, cap and migration probe inputs are unchanged, so their accepted evidence remains
valid and is not rerun. Integration is rerun because it is an explicit required continuation gate; both runs
will remain in this report. Durable lessons remain an ownership-safe handoff to the coordinator via this
committed report; docs/knowledge/ is not owned.

## Quiet-host continuation read results

FFI-07 released its reserved validation slot at 02:13:03Z. Each harness run checked for deno test/task
processes and printed /proc/loadavg before launch; load1 was < 1.5 each time. Reports retain exact Deno
loadavg values in cont-read-N.json; printed loads, stderr and exit statuses are adjacent. Every run has 20,000
samples per path in alternating blocking batches and the excluded warm-ups described above.

Quiet-host continuation (same date, fair harness above), 20,000 samples per path per run. All three runs exit
1 on **strict same-run node parity: FAILING**. All three absolute blocking and nonblocking budgets pass. No
threshold or binding code was changed.

| Run | Load 1/5/15        | node p50/p99 µs | FFI blocking p50/p99 µs | FFI nonblocking p50/p99 µs | Strict parity |
| --- | ------------------ | --------------- | ----------------------- | -------------------------- | ------------- |
| 1   | 0.50 / 1.35 / 1.76 | 6.93 / 28.00    | 7.35 / 29.97            | 43.85 / 322.94             | FAIL          |
| 2   | 0.70 / 1.38 / 1.77 | 7.21 / 29.24    | 7.64 / 29.66            | 47.56 / 745.04             | FAIL          |
| 3   | 0.70 / 1.38 / 1.77 | 7.10 / 29.19    | 7.57 / 31.80            | 47.80 / 480.43             | FAIL          |

Earlier run at load 1.38 / 1.35 / 1.39: blocking p50/p99 7.60 / 24.01 µs versus node 6.84 / 22.48 µs;
nonblocking 42.60 / 208.36 µs. Strict parity failed; absolute/NB budgets passed. The previous final run (8.96
versus 8.28 µs) is in the measurement table above. Every read run is retained in the evidence report;
quiet-host results supersede neither historical failures nor the unchanged gate.

The errors in all three cont-read-N.stderr.log files are the unchanged node parity assertion. Numerical
results also satisfy blocking <= 10.2 µs and nonblocking <= 100 / 3000 µs; parity is the sole failed read
acceptance criterion. The coordinator has explicitly authorized commit/push with this gate FAILING.

## Remaining companion regression discovered by continuation

The targeted nine-test rerun has 8 passed / 1 failed (678 filtered out). All original name/documentation/
column-count failures are repaired. Now that the fixture loads, the existing all-catalog nonempty assertion
reveals its next requirement: deadline-hits-per-handler-hour must have a deadline event in that fixture. The
shared fixture has only successful SQL events. proposed-deadline-fixture.patch adds one deadline row only
within this single test’s local setup callback, leaving shared fixture counts unchanged. The patch is prepared
and not applied pending an additional additive Owns authorization. Event at 02:15:12Z and the async
authorization request name the precise needed extension. cont-regression.log preserves the failure.

## Integration correlation defect and repair

The first continuation integration run passes the original checks, all 20 HTTP deadlines and the point-read
budget, but FAILS the final catalog assertion: 19 events attributed to winsByMark and one unmatched. The
retained JSONL explains the defect: the unmatched SQL timestamp is 02:20:15.985Z, while its HTTP completion
timestamp is 02:20:15.984Z (duration 57.957793 ms). The query's lower request-window bound already allowed 1
ms timestamp rounding, but the upper bound did not. SQL events use wall-clock milliseconds and HTTP completion
uses the Effect nanosecond clock; those timestamps can differ by one millisecond even when the statement
logically finishes first. The repair applies the same 1 ms tolerance at both boundaries, keeps one request per
SQL event via LIMIT 1, and preserves unmatched events. See cont-correlation-diagnostic.json and
cont-integration.log; all twenty pairs are preserved rather than only the failed pair. Documentation now
states that rounding tolerance applies at both boundaries. No trace-only unbounded join is introduced.

## Continuation validation in progress

- lint: PASS, 167 files; check: PASS; fmt:check: PASS, 256 files (initial continuation static checks).
- Explicit check of all three harnesses and the migration probe: PASS.
- test:prop: PASS, 79 passed / 0 failed (2m41s), cont-prop.log. No FFI-07 files are present or edited here.
- First integration: FAIL on final query attribution, retained in cont-integration.log and described above.
- Repaired integration: PASS, cont-integration-repaired.log. Original integration checks pass; 20 HTTP 504
  responses; 181 competing point reads, p99 16.435675 ms, load 2.126953 / 2.381348 / 2.130859, budget 50 ms.
  logs:ingest accepted 874 lines / 0 rejects. logs:query returned:

```json
[{
  "hour": "2026-10-14 02:00:00",
  "app_id": "tic-tac-toe-json",
  "handler_kind": "query",
  "name": "winsByMark",
  "path": "nonblocking",
  "deadline_hits": 20
}]
```

- Retained-database correlation probe: PASS, cont-correlation-probe.json; all twenty deadline rows now
  attribute to winsByMark and none is unmatched.
- Full unit run started while local deadline-fixture authorization is pending; known nonempty-fixture
  assertion is expected to fail until that scoped patch is authorized. CI waits for that resolution.

Full continuation unit run before local fixture authorization: **685 passed / 1 failed / 1 ignored** (5m27s),
cont-test-before-fixture.log. The sole failure is the already-described all-catalog nonempty fixture
assertion; all unrelated tests, including the known timing-sensitive cases, pass. The previous nine
compatibility failures are reduced to this one newly exposed setup requirement. No production correctness
failure is left by the integration correlation repair. Final unit/CI gates remain pending that narrowly scoped
patch.

## Proposed fixture patch rehearsal

Before applying the still-unauthorized patch to tests/unit/analysis_catalog_test.ts, the continuation copied
that existing test module into its owned evidence directory, applied precisely the proposed local fixture
change there, and adjusted only relative imports for the new depth. All **14 catalog tests passed / 0 failed**
(5s), including the previously failing all-catalog nonempty assertion and all existing numeric/trace
assertions. cont-fixture-rehearsal.log preserves the result. The temporary copy was removed after the run; the
actual test file remains unchanged beyond its authorized name/column-list edits. This is evidence for the
proposed patch, not a claim that the product unit suite or CI passes. No authorization has arrived as of 02:35
UTC; final unit/CI checks, implementation/evidence commits and branch push remain pending it.

## Continuation 2: authorized fixture and final gates

2026-10-14 · actor sol-ffi-06-cont2. Coordinator authorization at 02:37:40Z extends
`tests/unit/analysis_catalog_test.ts` to all additive tests/fixtures required by the new query. The exact
proposed deadline fixture patch was apply-checked and applied. Its row lives only in the all-catalog test's
local setup; the shared fixture and its numeric expectations remain unchanged. The formerly pending ownership
question is resolved. No performance harness is rerun, and strict same-run parity remains FAILING in all three
retained quiet-host runs. Absolute read budgets pass.

Final requested gates are being run sequentially, with a process-list check before each suite and
`cont2-*.log` / `cont2-*.exit.txt` preserving every result. The first check found an FFI-07 property suite, so
this unit waits for its completion before launching regression or other gates.

Learning assessment: no new VM finding. The fixture lesson is already recorded above; this committed report
hands it and the earlier catalog-correlation findings to the coordinator for an authorized knowledge
follow-up. No reusable script was created. Worktree cleanup remains with the coordinator after inspection, as
this unit's brief requires.

Continuation 2 gate results so far:

- Regression: 1 passed / 0 failed / 686 filtered out; the authorized fixture resolves the sole catalog
  failure.
- lint: PASS, 167 files; check: PASS; fmt:check: PASS, 256 files.
- First full test: 685 passed / 1 failed / 1 ignored (5m48s). The failure is
  `tests/unit/retention_ingest_test.ts:899`, asserting that the sustained-write scenario exercised the size
  cap. It accepted 3,328 events and dropped 3,072; no FFI/catalog assertion failed. The same test passed
  during the CI rerun (4,096 accepted, 2,304 dropped). Preserve this timing-sensitive fixture finding for the
  coordinator; this unit does not own the retention test.
- test:prop: PASS, 79 passed / 0 failed (3m42s).
- integration: PASS, both original checks and FFI-06 scenario. Twenty HTTP 504 responses; 152 competing point
  reads, p99 20.062359 ms at load 5.632813 / 5.622559 / 4.131348; load-scaled budget 70.410156 ms (also below
  the base 50 ms budget). logs:ingest accepted 758 lines / 0 rejects. logs:query returned:

```json
[{
  "hour": "2026-10-14 02:00:00",
  "app_id": "tic-tac-toe-json",
  "handler_kind": "query",
  "name": "winsByMark",
  "path": "nonblocking",
  "deadline_hits": 20
}]
```

The retained repaired integration evidence of 20 HTTP 504 responses and point-read p99 16.44 ms remains
unchanged and valid. Interrupt/cap/read harnesses were not rerun in continuation 2. CI is still running; its
final exit and counts will be appended before committing.

Final CI: **PASS, exit 0** (`cont2-ci.log`, `cont2-ci.exit.txt`): fmt/check/lint all pass, unit **686 passed /
0 failed / 1 ignored** (5m9s), property **79 passed / 0 failed** (3m37s). The earlier standalone unit result
remains **685 / 1 / 1 ignored** and is not replaced or hidden. The CI run resolves that isolated retention
coverage failure without any source edit. Every requested gate was executed. No native benchmark was rerun and
no acceptance gate was relaxed. Strict same-run node parity is still **FAIL**, as authorized for commit/push;
absolute budgets pass.

The implementation commit and separate evidence commit are pushed only to `item/ffi-06-evidence`. This report
commits the knowledge handoff, including the retention fixture's timing-sensitive coverage finding, for
coordinator inspection. No binding, frozen deno.json, FFI-07 files, other worktrees, main branch or
knowledge-store entries were changed. The worktree is retained for coordinator inspection.

Implementation SHA: `3fe5b5bbdf85381b0a4b3a86da716fb0aa3fb5ba`. The following evidence commit contains this
report, briefs, patches, probes and small logs; its SHA is named in the immutable completion event.
