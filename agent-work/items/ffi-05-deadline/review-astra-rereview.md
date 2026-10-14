# Astra re-review of FFI-05 after repair 1

**Verdict: PASS.** Reviewed `4c54ea3` (repair code `076b327`, brief `1055ab2`, knowledge `4c54ea3`). Primary
delta: `6246f9d..4c54ea3`; whole-item context: `702c354..4c54ea3`. Fresh reviewer actor:
`astra-ffi-05-rereview`; branch `review/ffi-05-astra-rereview`; date 2026-10-14.

## Numbered defect list

None. Both findings from the first review are closed. No additional blocking defect or required nit was found.
The observability follow-ups below are hand-offs, not defects requiring another repair round.

## Repair verification

1. **First review defect 1 (P2): closed.** `platform/document_reader.ts:219` centralizes admission in `admit`:
   check context, increment operations, then check poison. The blocking callback calls it at line 238; the
   nonblocking guard calls it at line 245. Both execute after the gate's busy check/wait, before native
   preparation or execution. `ConnectionGate` itself is unchanged by the repair; its retry checks the current
   claim again after each wakeup. COMMIT's callback at line 379 expires the context before calling native
   COMMIT, in one synchronous step. The release at line 330 expires the context before waiting for ROLLBACK,
   so even a waiter queued before the rollback waiter refuses when awakened. The expired-context return at
   line 277 bypasses SQL event construction, and admission returns before the counter increment. Poisoned
   attempts retain their separate error/count behavior; they are not the expired-context case.

   I fetched the first review's `review-reader-race.ts` from `origin/review/ffi-05-astra` into the requested
   scratch directory, redirected relative imports to this checkout, and used a temporary database file. Both
   immediate and `delay-sink` modes returned a successful handler, successful count of zero, and a late
   `ContextExpiredError`. Both traces ended `sql ok → COMMIT → tx commit`, with no late native call or SQL
   event. These are diagnostic traces, not assertion-based test scripts; I inspected the exits and ordering.
   See `rereview-evidence/race-immediate.log` and `race-delay-sink.log` beside this report.

   I also ran a scratch variant that lets the late read queue at 10 ms, fails the handler at 20 ms, and
   records native `allAsync` starts and transaction operation counts. Both blocking and nonblocking late reads
   failed `ContextExpiredError`; only the original count started, ROLLBACK ran, and `tx.operations` was 1. The
   intentional handler error remained the original defect. See `rollback-blocking.log` and
   `rollback-nonblocking.log`.

   The committed regression at `tests/unit/document_reader_test.ts:534` covers blocking/nonblocking late reads
   × immediate/yielding transaction sinks. It asserts the typed failure, exactly one SQL event, commit, one
   operation, and no event after tx. Its line 615 fixture check requires
   `lateStarted > 0 && lateStarted < countSettled`; this prevents an already-finished-count fixture from
   silently satisfying the regression. In my run, the four late starts were 16.0/13.8/13.2/13.4 ms, versus
   count settlement at 185.9/176.0/176.6/183.3 ms (load1 1.36). All four passed. I did not independently rerun
   the repair agent's negative-control checkout; that agent's claim that all four fail on `6246f9d` remains
   attributed to the repair report.

2. **First review defect 2 (P3): closed.** The gate fixtures at `tests/unit/storage_test.ts:931`, `:1027`, and
   `:1047` now execute their native calls inside `start`, returning completed effects. The new test at line
   945 uses deferred hand-off signals to let a competing nonblocking claimant take the connection before the
   returned effect proceeds. The correct callback returns 1; the deliberately deferred callback must fail with
   `SqliteUsageError` reason `busy`. Both competitor counts must finish at 300001. This checks the contract
   boundary rather than relying on two unrelated timers to race. The test passed (395 ms), as did the original
   queued-statement and grace fixtures.

## Event delivery judgment: acceptable with a hand-off

The already-admitted nonblocking read releases its native claim before emitting its SQL event
(`platform/document_reader.ts:272`–`:282`; writer analogue `platform/sqlite.ts:588`–`:621`). COMMIT may
therefore proceed while that fiber is delivering the event. I reproduced this by making the scratch sink sleep
20 ms **before recording SQL events**: the count succeeded, the escaped late read still failed
`ContextExpiredError`, and the recorded order was `COMMIT → tx commit → sql ok`. See
`rereview-evidence/event-order.log`.

This is delivery ordering of a statement that completed inside the snapshot, not post-COMMIT execution or a
newly admitted operation. FFI-05 requires accurate path/outcome events and deadline rollback; it does not
establish tx as a drain barrier for escaped fibers' event delivery. The writer similarly emits outside the
claim, and the live logger's sink synchronously offers records to its queue
(`platform/logging/logger.ts:494`). Ordinary awaited operations still emit before their handler returns. I
therefore classify this as **acceptable with an observability hand-off**, not a NIT or FAIL. The comment at
reader line 275 is understood as referring to the refused select's nonexistent event, not a global ordering
guarantee.

Coordinator hand-off: when defining event ordering guarantees, document that a transaction record does not
currently drain escaped fibers' SQL event delivery. If strict ordering is desired, design it jointly for
reader and writer, and test a sink that yields before recording SQL (not only one that yields on tx). Do not
infer native execution order solely from cross-fiber sink delivery order.

## Whole-item assessment against FFI-05

- The classifier is pure IR logic and exhaustive over Operation. Every SDK operation shape is captured in
  tests; 2,000 generated select plans exercise both classifications. Only nonaggregate `_id` equality reads
  take the bounded path. Writes remain blocking, as do transaction control, startup SQL, and snapshots.
- Both reader and writer unbounded reads use binding `timeoutMs`; writer NUL probes follow their read's path.
  No new Effect timeout wrapper substitutes for the binding's deadline. Deadline cancellation maps to
  `StatementDeadlineError`, HTTP 504, and the expected rollback/error events. IPC timeout remains 502. Service
  widening, the DbError insertion point, ADR row, and closed error exhaustiveness remain coherent.
- Gate ownership spans asynchronous execution and cancellation cleanup; its watchdog uses real timers, joins
  before release, poisons overdue connections, and closes them before waking later callers. Typed native
  failures retain their provenance; caller defects are not converted into owned deadline failures. The repair
  does not change these mechanics, the binding, writer serialization, SDK, compiler, or frozen configuration.
- Cached blocking statements are prepared and used in the same synchronous callback. Nonblocking statements
  stay protected by the claim. The reader's extra active check is constant work with no added asynchronous
  boundary; point reads still use the blocking path. The timing checks below show no obvious hot-path
  regression, but are not a new interleaved k6 baseline comparison.
- All SQLite SQL event construction sites set `path`. The first review's JSONL omission (`KIND_KEYS.sql`)
  remains the explicitly documented FFI-06 hand-off. Its other non-defect findings remain applicable: row-step
  pool overhead, missing end-to-end poisoned WAL-writer seam, and older ConfigTest timeout pairs.

## Independent validation

Suites ran sequentially, followed by the scratch probes. All required commands exited 0; no known timing flake
or retry occurred. Loads below are Linux 1/5/15-minute averages, sampled at command start and end. Full
command logs remain in this worktree's `rereview-evidence/`; the five probe logs are committed.

| Command                               | Result                                                                                                       | Start load         | End load           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------ |
| `deno task lint`                      | 164 files checked                                                                                            | 0.96 / 1.28 / 1.31 | 0.96 / 1.28 / 1.31 |
| `deno task check`                     | All configured roots passed                                                                                  | 0.96 / 1.28 / 1.31 | 0.97 / 1.27 / 1.30 |
| `deno task test`                      | 686 passed, 0 failed, 1 ignored; test runner 4m34s                                                           | 0.97 / 1.27 / 1.30 | 0.98 / 1.28 / 1.32 |
| `deno task test:prop`                 | 79 passed, 0 failed; test runner 2m53s                                                                       | 0.98 / 1.28 / 1.32 | 1.86 / 1.62 / 1.45 |
| `deno task integration`               | PASS: both layouts, read-after-write, aggregation, isolation, backup/restore, auth, traces, ingest, analysis | 1.86 / 1.62 / 1.45 | 1.79 / 1.61 / 1.45 |
| `deno fmt --check` on repair delta    | 5 files passed                                                                                               | —                  | —                  |
| `deno fmt --check` on full item delta | 15 files passed                                                                                              | —                  | —                  |
| `git diff --check 702c354 4c54ea3`    | Passed                                                                                                       | —                  | —                  |

Timing evidence (4 CPUs, original unscaled bounds):

- Reader deadline 50 ms: statement 51.4/51.3/51.0 ms; call 57.2/55.1/54.8 ms, median 55.1 against 70 ms; load1
  1.30. Concurrent point reads 2.89/2.56/2.08/1.99/2.02 ms, median 2.08 against 5 ms. All five completed
  before the long count's deadline event.
- Writer deadline: statement 52.9 ms, mutation 58.7 ms; load1 1.36. Rollback, absence of the marker row,
  next-mutation success, and blocking point-read events all passed.
- Grace fixture: deadline 30 + grace 100 ms; stuck notification 133.8 ms, step return 604.9 ms (busy timeout
  600 ms), load1 1.36. The queued caller observed the closed poisoned handle.
- Scratch probes: load averages ranged from 0.92/1.38/1.38 to 1.01/1.39/1.38. Every observed late read failed
  ContextExpiredError.

The reproduction was run with `deno run -A --config deno.json` and the scratch script's absolute path (no task
exists for that diagnostic). Its directory is
`/tmp/claude-0/-root-Software-ts-db/4baa5237-5a2a-4889-84ed-3eddee24e601/scratchpad/`; filenames are
`rereview-reader-race.ts`, `rereview-reader-rollback.ts`, and `rereview-reader-event-order.ts`. No
reproduction script is committed. E2E and k6 were not rerun in this re-review; the first review recorded 7/7
E2E success and explicitly relied on the builder's k6 comparison. This report makes no fresh E2E or p50
baseline claim.

## Learning assessment and coordinator hand-offs

The repair's durable context-after-wait and synchronous-expiry lessons are already preserved in
`docs/knowledge/gotchas.md` by `4c54ea3`; no duplicate knowledge edit is needed. This committed report hands
off the event-delivery distinction above, within reviewer ownership. Retain the prior review's FFI-06 work:
add `KIND_KEYS.sql.path` and its golden test alongside the DuckDB column, retain raw perf evidence and measure
at the reader cap, track batched pool stepping, and add a poisoned WAL-writer seam when authorized. Older
ConfigTest deadline pairs, duplicate IPC error alias, and config wording remain maintenance follow-ups.

No new VM/environment finding or reusable work script arose. Only `agent-work/` artifacts were changed. No
implementation fix, merge, or main push was performed. Retain this worktree for coordinator inspection; the
coordinator can remove it after inspecting the committed report.
