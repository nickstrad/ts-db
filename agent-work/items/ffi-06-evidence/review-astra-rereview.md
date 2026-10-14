# FFI-06 Astra re-review

2026-10-14 · actor `astra-ffi-06-rereview` · branch `review/ffi-06-astra-rereview`. Reviewed `6417cda` (code
`11f4e04`), fixup delta `300470d..11f4e04`, whole item `f2bf1c9..11f4e04`. This is a review only; no product,
test, or documentation fixes were made.

## Verdict

**NITS**, excluding the escalated parity gate. One nonblocking test-coverage defect remains; the production
query is correct on the inspected cases. The other seven Opus NITS are resolved, and I found no functional
regression in the fixup. The pre-existing interrupt tick gate and cancellation timing flake are separate
handoffs below, not new fixup defects.

**The strict same-run `node:sqlite` parity gate as written still fails.**

The parity harness and thresholds are byte-for-byte unchanged by this fixup. This statement relies on the
retained quiet-host runs and the Opus review at `300470d`; I did not rerun or amend that escalated gate.

## Numbered defect list

1. **P3 — `tests/unit/analysis_catalog_test.ts:346`: the new correlation fixture does not protect trace
   matching or the lower request-window bound.** All different-trace requests occupy separate time windows,
   and no SQL event precedes its matching request's widened start. Removing either predicate independently
   from `platform/analysis/catalog.ts:90-92` leaves the new test green (1 passed, 0 failed). Thus regressions
   that attribute a SQL event to a different trace, or to a same-trace request which has not started, can
   escape the test despite its claim to pin these rules. Add an event with a different trace inside an
   existing same-app request window, plus events exactly 1 ms and 2 ms before a request starts; assert the
   expected match/NULL attribution. This completes Opus NIT 1; it does not require changing the query.

   Reproduce independently with the following substitutions in a scratch copy of the catalog, running the new
   test after each substitution:

   - Delete `request.trace_id = s.trace_id AND` from its `WHERE` clause: test still passes.
   - Delete `AND s.ts >= request.ts - (request.duration_ms + 1) * INTERVAL '1 millisecond'`: test still
     passes.

   Test command:

   ```sh
   deno test -A --filter 'AnalysisLive: deadline-hits-per-handler-hour pins' tests/unit/analysis_catalog_test.ts
   ```

   In this review the original test was run with `--import-map` redirecting the catalog's absolute file URL to
   each scratch copy under `agent-work/`. The copies' two relative imports were resolved back to the original
   `core/errors.ts` and `platform/services.ts`. The import maps retained the `deno.json` package mappings and
   explicitly mapped `effect/Schema` to `npm:effect@3.22.2/Schema`. No production file needed editing or
   restoration. Initial scratch-map setup attempts failed import resolution/type checking and are not counted
   as mutation evidence; the table below is from the corrected maps and actual test runs.

## Mutation evidence

Each mutation was independent of the others. Logs are in [rereview-evidence](rereview-evidence/).

| Catalog variant                          | Exit | Result of the new test                                    |
| ---------------------------------------- | ---- | --------------------------------------------------------- |
| Unchanged control copy                   | 0    | 1 passed, 0 failed                                        |
| Remove trace match                       | 0    | Survives: 1 passed, 0 failed                              |
| Widen upper tolerance from 1 ms to 10 ms | 1    | Caught at line 378: `play/nonblocking` is 3, expected 2   |
| Remove lateral `LIMIT 1`                 | 1    | Caught at line 374: total is 13, expected 11              |
| Remove lower time-window predicate       | 0    | Survives: 1 passed, 0 failed                              |
| Remove app match                         | 1    | Caught at line 387: unmatched app2 hits are 0, expected 1 |

The requested claim that each of trace removal, tolerance widening, and limit removal fails is therefore **not
true**: two are caught and trace removal survives. The additional lower-bound probe also survives.

The pinned values themselves match the documented rule: `d8` belongs to earliest-completing `x1`; the
back-to-back `d9` tail belongs to `a1`, with `d10` going to `b1`; `d7` is bucketed into SQL hour 13:00 even
though the request completed in 12:59; and the older NULL-path row is carried and counted. The query's
deterministic secondary ordering is `request.event_id`. This fixup does not change the query.

## Eight-NIT audit and fresh-eyes review

1. **Value assertions: partial.** Counts, app mismatch, upper tolerance, duplicate timestamps, shared trace,
   back-to-back reuse, SQL-hour bucketing, error filtering, and NULL path are checked. The residual coverage
   gap is defect 1 above.
2. **Interrupt JSON: resolved.** The invented `rc: 9` field is removed from the sample type and output.
   Compared against `origin/research/fable-lang-switch:work-scripts/deno/ffi-sqlite-interrupt.ts`, every other
   PoC metric key is retained. Both the output notes and README explain typed cancellation versus the PoC's
   measured native result code. The 50 iterations and both gates are unchanged.
3. **Evidence presentation: resolved.** The README's measurement section starts with the failing parity status
   and quiet-host runs. Earlier read runs and pre-repair integration evidence are labelled as historical;
   later integration results appear first. No read threshold or exit-status change.
4. **PoC attribution: resolved.** `work-scripts/INDEX.md` names `research/fable-lang-switch`, commit
   `d97bcf8`, Fable, 2026-10-12, and stable `perf/` replacements. This matches the research commit.
5. **Hour buckets: resolved.** Integration filters app/name/path and reduces all matching rows' hits,
   comparing the sum to `pass.rounds`; crossing an hour no longer changes the assertion.
6. **Point-read budget: resolved.** A flat `POINT_P99_BUDGET_MS = 50` replaces the load factor. The measured
   load is printed, not used to relax the threshold.
7. **Header and tracing-disabled pass: resolved.** The module header describes both passes and new
   dependencies. The 3-round second pass asserts HTTP 504, exactly three nonblocking deadline SQL events, and
   three catalog hits. `String(pass.traceSql)` is spread into `startScratchServer`'s child environment; the
   reader inherits it, and the config decoder treats `"false"` as false. During my integration run, `/proc`
   observations confirmed `TRACE_SQL=false` in both the server (PID 3833881) and reader (PID 3833894), not
   merely in the parent test. Only the `TRACE_SQL` environment entry was recorded.
8. **Upgrade and attribution docs: resolved.** The documented one-time `logs:ingest`, periodic ingest sweep,
   and `POST /admin/logs/ingest` all reach the idempotent DDL migration. The note correctly describes the
   pre-ingest binder failure and NULL historical paths. Attribution limitations match the query.

The large integration diff is mostly indentation from parameterizing the scenario; a whitespace-insensitive
review confirms the semantic changes above. Each pass has its own scratch root, database, and scoped server.
Cleanup still stops the server before dropping the private Postgres database. The initial integration scenario
is unchanged. Across the whole item, `path` is persisted through `KIND_KEYS`, explicit typed insert columns,
nullable DDL, and idempotent migration; only the affected SQL-event golden changes. No binding, `deno.json`,
FFI-07, or files outside the authorized Owns/extension were changed by the builder/fixup.

## Reviewer validation

- **First `deno task ci`: exit 1.** Formatting (256 files), lint (167), and type checking passed. Unit result:
  686 passed, 1 failed, 1 ignored. The failure was the unchanged cancellation race test at
  `tests/unit/sqlite_ffi_cancel_test.ts:362`: immediate-abort maximum 51.068 ms versus a strict 50 ms bound
  (median 2.554 ms). All earlier semantic cancellation/reuse assertions passed. Property tests were not
  reached because CI short-circuits. See `ci.log` and `ci.exit.txt`.
- **Isolated cancellation-race rerun: exit 0.** 1 passed, 0 failed; immediate-abort median 0.272 ms, maximum
  4.365 ms; 16 queued cancellations settled in 1.736 ms. No source changes. See `race-retry.log`.
- **Second `deno task ci`: exit 0, without source changes.** Formatting (256 files), lint (167), and type
  checking passed; unit 687 passed, 0 failed, 1 ignored (4m35s); property 79 passed, 0 failed (2m26s). The
  cancellation race passed in this full run too. Start load 0.99 / 1.28 / 1.77. See `ci-retry.log` and
  `ci-retry.exit.txt`.
- **`deno task integration`: exit 0.** Original checks passed. Tracing-enabled pass: 20/20 HTTP 504, 152
  competing point reads, p99 **21.365 ms**, flat budget 50 ms, load **1.006 / 1.302 / 1.791**; ingest 758
  lines, zero rejects; catalog `winsByMark / nonblocking / 20`. Tracing-disabled pass: 3/3 deadline failures,
  ingest 56 lines, zero rejects; catalog `winsByMark / nonblocking / 3`, load **1.079 / 1.308 / 1.788**. See
  `integration.log`, `integration.exit.txt`, and `integration-env.log`.
- **`deno run -A perf/ffi_interrupt.ts`: exit 1, tick gate only.** 50 samples, interrupt p99 **3.726 ms**
  (passes 20 ms), minimum **85 ticks** (fails 90), start load **0.459 / 1.687 / 2.189**. The first window had
  85 ticks; later windows had 91–97. No `rc` field is present. See `interrupt.log`.
- **Mutation controls and faults:** table above; every successful control/surviving mutation ran one test, and
  every caught mutation failed its value assertion, not setup or import resolution.
- The prescribed process check was performed before every suite/harness. No matching competing Deno suite or
  Muse process was running at those checks. Validation ran sequentially in this worktree.

## Handoffs and learning assessment

- **Interrupt tick fragility is not introduced by this fixup.** The diff only removes `rc` and updates
  explanatory notes. The same 90-tick assertion existed at `300470d`; Opus and the fixup already observed
  failures. My quiet-start run adds evidence that a low one-minute load alone does not guarantee it. Hand the
  gate/warm-up methodology to the coordinator; changing a plan threshold is outside this review.
- **Additional cancellation timing flake:** `sqlite_ffi_cancel_test.ts:287/362` is distinct from the known
  `:76` flake. The test and its binding imports are unchanged across the whole item; it imports no changed
  catalog/event-log/integration code. Preserve the first failure and clean rerun, and consider adding this
  exact case to the coordinator's timing-flake list. Do not confuse it with a failed cancellation result.
- **Project knowledge handoff:** correlation fixtures must vary trace/app/time independently; otherwise one
  predicate can disappear while another accidentally preserves every expected row. The committed mutation
  evidence demonstrates this for trace and the lower bound. A coordinator or fresh authorized documentation
  unit can add the lesson to `docs/knowledge/`; this reviewer owns only `agent-work/`.
- Opus's earlier cap-through-Effect and plan-risk handoffs remain open; this re-review does not claim to
  discharge them. The parity amendment still requires the existing human decision.
- No new reusable script or VM/environment knowledge needs preservation. Scratch catalog copies and import
  maps are disposable; evidence and this report preserve the findings. Worktree retained for coordinator
  inspection and subsequent cleanup, with no merge or other-worktree action.
