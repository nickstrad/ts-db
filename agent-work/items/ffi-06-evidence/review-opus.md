# FFI-06 review (Claude Opus 5.5, actor opus-ffi-06-review)

Reviewed: `item/ffi-06-evidence` @ `300470d` (implementation `3fe5b5b`, evidence `300470d`), base `main`
`f2bf1c9`. Plan: `origin/plan/ffi-implementation:docs/plans/ffi-implementation.md` §2, §4 FFI-06, §5. Briefs:
`brief.md`, `brief-continuation.md`, `brief-continuation-2.md`. Date 2026-10-14, vm-1, Deno 2.9.5, 4 vCPU.

## Verdict

**FAIL against the plan as written.** The one failing acceptance criterion is the strict same-run parity gate
(`perf/ffi_read_cost.ts:70`, blocking p50 ≤ `node:sqlite` p50). I reproduced the failure. Every other
acceptance criterion passes, and I ran each one myself.

**Under the proposed amendment (FFI-01's 1.3 × node p50 + 1 µs), the item would PASS with NITS.** All four of
the builder's quiet-host runs, its two historical runs and my run fall well inside that threshold. Nothing
else blocks.

## Parity ruling

| Run (load1)               | node p50 µs | FFI blocking p50 µs | strict ≤ node | 1.3 × node + 1 µs |
| ------------------------- | ----------- | ------------------- | ------------- | ----------------- |
| builder 1 (0.50)          | 6.93        | 7.35                | FAIL          | PASS (≤ 10.01)    |
| builder 2 (0.70)          | 7.21        | 7.64                | FAIL          | PASS (≤ 10.37)    |
| builder 3 (0.70)          | 7.10        | 7.57                | FAIL          | PASS (≤ 10.23)    |
| reviewer, this run (0.77) | 7.43        | 7.69                | FAIL (exit 1) | PASS (≤ 10.66)    |

In my run, nonblocking p50 was 61.18 µs and p99 1302.89 µs (both pass). Blocking p50 7.69 µs is within the
10.2 µs PoC budget (pass).

**The harness is fair.** Both drivers open identical, separately seeded 1,000-row WAL files in a fresh temp
dir (`perf/ffi_read_cost.ts:8-10`). `node:sqlite` never opens a file the binding has open. Each driver reuses
one prepared statement, decodes the same single TEXT column and returns one object row. Bind arrays are
precomputed. Each path gets 2,000 warm-ups that are not timed. The 10 timed batches of 2,000 alternate which
driver goes first. Assertions sit outside the timed interval. The one asymmetry favours FFI: node pays an
argument spread, `ns.get(...params)`, which costs 0.1–0.2 µs in my probe.

**The gap is a genuine per-read FFI cost, and the gate was set from a biased PoC number.** I wrote a
decomposition probe (scratch only, not committed). It interleaves five paths over five separate files after
warm-up:

| load1 | node | node spread | production `Statement.get` | raw PoC loop (bind_int/step/getCString/reset) |
| ----- | ---- | ----------- | -------------------------- | --------------------------------------------- |
| 0.56  | 6.78 | 6.94        | 7.40                       | 7.44                                          |
| 0.60  | 7.18 | 7.40        | 8.23                       | 7.91                                          |
| 0.60  | 7.01 | 7.10        | 8.15                       | 7.92                                          |

(p50 µs, 20,000 samples per path.)

- **The PoC's own raw-symbol loop also loses to `node:sqlite` when measured fairly.** The production binding
  is within about 0–4 % of that loop. Its guards, cancellation state and lossless text handling add little.
- **The gap is the floor of four FFI crossings per read,** against node's single native call.
- **The PoC's "6.35 vs 8.66 µs" is a harness artefact.** In the PoC, node ran first, cold, with no warm-up and
  no interleaving, at load 3.3–4.9.
- **So the strict gate cannot be met by any FFI binding that crosses per call.** I recommend the amendment.
  FFI-04's end-to-end point reads measured 10 % faster than `node:sqlite`, so the micro-cost does not show up
  at the API.

## Acceptance check

1. **Read cost: FAIL as written (parity), all other gates pass.** The JSON shape matches the PoC (`runtime`,
   `node_sqlite_sync_us`, `ffi_blocking_us`, `ffi_nonblocking_us`, `notes`, each with `p50_us`/`p99_us`/`n`),
   plus `loadavg`. Load is recorded.
2. **Interrupt: PASS.** My run: 50 iterations, p99 4.034 ms, minimum 90 ticks (exactly at the gate), load
   0.58, libsqlite3 3.45.1. Builder: p99 6.1 ms, minimum 92 ticks.
3. **Cap: PASS.** My runs: 32/32 `SqliteCancelled` with reason `deadline`; max 84.5 ms (load 0.58), then 79.4
   and 85.9 ms (load 1.0). The timed span runs from just before `allAsync` is submitted until the typed
   rejection is caught (`perf/ffi_cap.ts:158-172`). That boundary is honest and includes everything from
   submission onward. It is the raw binding boundary, though, not the production stack (hand-off B).
4. **Integration: PASS.** My run: 20 × 504 `StatementDeadlineError`, 162 point reads, p99 15.00 ms at load
   1.09 (budget 50 ms). `logs:query` returned `winsByMark`/`nonblocking`/20.
   - `statementDeadlineMs` is 50 and `READER_CALL_TIMEOUT_MS` is 10000, which satisfies FFI-02's cross-field
     rule.
   - The overlap sampling is real. Point reads start 10 ms after the count request is sent and loop
     sequentially until it settles. A read already in flight when it settles is still counted. `overlap >= 50`
     asserts at least 50 reads finished while a count was outstanding.
   - If the count blocked the event loop, every read in its window would wait past the deadline and fail the
     p99.
5. **Event-log column and catalog query: PASS.**
   - `KIND_KEYS.sql` gains `path`. Only the sql golden line in `tests/unit/events_test.ts` changes.
   - The DDL adds nullable `path` at the end of the table. `ALTER TABLE sql_events ADD COLUMN IF NOT EXISTS`
     runs after the version guards. Typed inserts name their columns (`platform/eventlog/tables.ts:328`), so
     column order does not matter.
   - **Real pre-FFI-06 log:** I built a v2 file with the `f2bf1c9` DDL plus one old row, then ran
     `logs:ingest` on a new JSONL. Ingest succeeded with 2 lines and 0 rejects. The old row reads `path` NULL
     and the new row reads `nonblocking`.
   - **Correlation:** an edge-case probe of 7 deadline rows produced exactly 7 hits.
     `LEFT JOIN LATERAL …
     LIMIT 1` gives one row per SQL event, so nothing is counted twice. Results by
     case:
     - Reused trace across sequential handlers: each event goes to the right handler.
     - +1 ms upper tolerance: matched.
     - +2 ms past the window: unmatched (NULL handler).
     - Same trace in a different app: unmatched.
   - **Known mis-attribution windows, documented as limitations:** with simultaneous same-trace requests, the
     earliest-completing request wins; with back-to-back reused traces, an event in the 1 ms after the earlier
     request completes goes to that earlier request.
   - The `docs.md` and `docs/observability.md` rows are accurate. The `analysis_catalog_test.ts` changes are
     additive: the name assertion, an explicit column list, and a local deadline row.
6. **Script index: PASS.** `work-scripts/INDEX.md` marks both PoCs superseded and points at the research
   branch (wording NIT 4).
7. **Ownership: PASS.**
   - `3fe5b5b` touches only the brief's Owns plus the three extended files. `ffi_cap.ts` is in the brief's
     Owns.
   - `300470d` touches only `agent-work/items/ffi-06-evidence/`.
   - No binding, `deno.json`, FFI-07 or knowledge files were touched.
   - The evidence volume is reasonable: 668 KB in 78 files, the largest an 83 KB unit log, nothing multi-MB.
     Every retained failure backs a claim in `report.md`. No trim is needed.
8. **Retention flake: not caused by this diff.**
   - The failing assertion is `tests/unit/retention_ingest_test.ts:899`, `capPruned > 0`.
   - That test emits only `lifecycle` records (`:83`, `:806`). This diff changes only the `sql` key list, so
     it cannot touch them.
   - Whether the size cap is ever exercised depends on how many synchronous 100-event bursts survive the
     logger queue (capacity 64). That count is timing-dependent: 3,328 accepted in the failing run against
     4,096 in the passing one.
   - So it is a load-sensitive coverage assertion. It is not yet in the documented flake list (hand-off E).

## Defects (as written)

1. **`perf/ffi_read_cost.ts:70`: strict same-run parity fails.** Blocking p50 is 3.5–6 % above `node:sqlite`
   in every quiet-host run, and the harness exits 1. This fails the plan's FFI-06 acceptance as written.
   Reproduce with `deno run -A perf/ffi_read_cost.ts` at load1 < 1.5. It is not repairable inside FFI-06's
   Owns (see the parity ruling). Resolution is the plan amendment, not code.

## NITS (do not block under the amendment)

1. **`tests/unit/analysis_catalog_test.ts:257-262`: the new query has no value assertions.** It is only
   checked for `rows.length > 0`, while every other catalog query has assertions in "AnalysisLive: query
   results". The correlation rule has already needed one repair (the upper 1 ms bound). Its cases are pinned
   only by an integration count and the uncommitted evidence probe: reused trace, both tolerance bounds,
   unmatched → NULL, cross-app. A few asserted rows in the shared test would pin them.
2. **`perf/ffi_interrupt.ts:118`: `rc: 9` is hard-coded, not measured.** `SqliteCancelled` carries no result
   code. The field mirrors a PoC measurement but is a constant. Either drop it or say "implied by
   `SqliteCancelled`" in `notes`.
3. **`perf/README.md:197`: the run labelled "Final integration run" is the first unit's pre-repair run** (153
   reads, 22.10 ms). The later runs are 181 reads at 16.44 ms, and 152 reads at 20.06 ms at load 5.63 with a
   70.41 ms budget. The table at `:164` also leads with the historical 8.96/8.28 µs run, not the quiet-host
   runs.
4. **`work-scripts/INDEX.md:25,29-30`: wording.** "on this branch" is wrong once merged; say `perf/`. The
   Date/Author columns credit the research-branch PoCs to "sol (FFI-06)", 2026-10-14.
5. **`tests/integration.ts:627`: hour-boundary flake.** `projected.some(... deadline_hits === 20)` fails if
   the 20 rounds straddle an hour boundary, which splits the rows. Summing the matching rows would be robust.
6. **`tests/integration.ts:563`: the load-scaled budget goes beyond the plan.** `50 × max(1, load1 / cores)`
   exceeds the plan's flat "< 50 ms p99", and risk 11 asks for same-run ratios, not a load factor. One
   recorded run used a 70.41 ms budget. Every recorded p99 was under 50 ms anyway.
7. **`tests/integration.ts:1-23`: the module header lists the server-up/down checks but not the FFI-06
   scenario.** It also does not mention that the module now imports `npm:postgres` and the binding.
   `TRACE_SQL=true` (`:491`) means the scenario does not exercise the documented "failed statements are logged
   without `TRACE_SQL`" claim. The code at `platform/document_reader.ts:280` does implement it.
8. **`platform/analysis/catalog.ts:83-101` with `docs/observability.md`: the new query fails on an un-ingested
   old file.** Against a pre-FFI-06 v2 file that has not been ingested since the upgrade, it fails with
   `AnalysisError: Binder Error: Table "s" does not have a column named "path"` (exit 1, reproduced). Other
   queries are unaffected, and the next ingest (including the reader's startup ingest) heals it. A one-line
   doc note would do: "run `logs:ingest` once after upgrading."

## Hand-offs for the coordinator and plan (not defects of this item)

- **A. Parity amendment.** Take 1.3 × + 1 µs (or ≤ 1.1 × node) to the human, with the decomposition above:
  even the PoC's raw loop fails strict parity once the comparison is fair.
- **B. The cap at the production boundary.** I put the same 32-statement test through FFI-03's Effect layer
  (`effect.ts` `allAsync`, `Effect.all` with unbounded concurrency, each fiber timed from its own start) at
  load 1.0.
  - Results: 108.1, 112.5 and 81.4 ms max elapsed. Fiber start offsets reached 77 ms, and cancel latency
    reached 56 ms.
  - The raw harness measured 79–86 ms. The builder's retained Effect diagnostic was 139.85 ms.
  - The cause is CPU contention, not blocking-pool starvation: 32 CPU-bound steps on 4 vCPUs delay the main
    thread's deadline timers and continuations.
  - The production document reader goes through this layer, so "no starvation at the 32-permit cap" is shown
    only at the raw binding boundary, with about 15 ms of margin.
  - Plan follow-up: measure at the document reader or HTTP, or revisit the per-tenant sub-cap (risk 6).
- **C. Interrupt tick gate.** My quiet run hit exactly 90 ticks; a loaded run measured 61. The gate is
  load-fragile, and a ratio or load-aware gate would be steadier.
- **D. §5 risk actions assigned to FFI-06 that were not in the brief and are undone:**
  - Risk 14: re-express the `sqlite_ffi_cancel_test.ts:76` thresholds as ratios.
  - Risk 4: `perf:smoke` p99 within 10 % of `main`.
  - Risk 15: re-measure the per-row hop at the 32-reader cap. Assign them or amend the plan.
- **E. `retention_ingest_test.ts:899` flake.** Add it to the known timing flakes, or open a side quest to make
  the size-cap path deterministic.
- **F. Lessons for `docs/knowledge/`.** These are in `report.md`: a 1 ms skew between wall-clock and Effect
  clock timestamps; `KIND_KEYS` is required for persistence; positional SQL fixtures break on added columns.
  Add the two cap-boundary and parity-PoC-bias findings above.

## Validation (reviewer, this worktree @ 300470d)

- **`deno task ci`: exit 0.** fmt:check 256 files; lint 167 files; check ok; unit 686 passed, 0 failed, 1
  ignored (5m6s); property 79 passed, 0 failed (3m3s).
- **`deno task integration`: exit 0.** Both original checks pass. FFI-06: 162 reads, p99 15.00 ms, load 1.09,
  20 × 504, `logs:query` 20 nonblocking.
- **`perf/ffi_read_cost.ts`: exit 1 (node parity only).** Load 0.77 / 2.21 / 3.13.
- **`perf/ffi_interrupt.ts`: exit 0.** p99 4.034 ms, minimum 90 ticks, load 0.58.
- **`perf/ffi_cap.ts`: exit 0 on all three runs.** Max 84.5, 79.4 and 85.9 ms.
- **Scratch probes (not committed):** catalog correlation edge cases; pre-FFI-06 log ingest and query;
  read-cost decomposition (3 runs); cap through the Effect layer (3 runs).
- **Suite etiquette:** I checked the process list before each suite and waited out one FFI-07 suite and one
  short FFI-07 probe.
