# FFI-06 delta re-review (Opus 5.5)

Actor `opus-ffi-06-rereview`, branch `review/ffi-06-opus-rereview`. Reviewed head `06f706d` (fixup code
`3257375`), delta `git diff 6417cda 06f706d`, base `main @ f2bf1c9`.

## Verdict: NITS

The gate, the test fix and the validation all hold. Two sentences in `perf/README.md` still describe the
pre-amendment state. Neither blocks landing.

1. `perf/README.md:200-201`: "the quiet-host results supersede neither the historical failures nor the
   **unchanged gate**." The gate is no longer unchanged: this commit amends it, and line 164 says so.
   Suggested wording: "...nor the historical strict-parity failures."
2. `perf/README.md:205-206`: "No failed threshold is relaxed by these ports." Since the amendment, the
   node-parity threshold _is_ relaxed (strict `<=` became `1.3x + 1 us`). The relaxation is human-approved and
   its provenance is documented, but this sentence now contradicts lines 164-172. Suggested wording: "Apart
   from the approved parity amendment, no failed threshold is relaxed."

Observation (not a defect): the quiet-host table's "Amended gate" column is computed from the old harness's
JSON. Those runs exited 1 under strict parity. The claim that the amended harness "exits 0 on a quiet host"
rests on runs of the amended harness: the fixup's run (7.72 vs 7.25, bound 10.43, load 1.25) and the one
below. Both agree with the computed column.

## Checks

1. **Harness (`perf/ffi_read_cost.ts`)**: the delta replaces one assert with
   `p50_us <= 1.3 * node_sqlite_sync_us.p50_us + 1` (microseconds; same unit as `pct`). Its message names the
   2026-10-13 amendment. The PoC budget (6.8 x 1.5), the nonblocking p50 100 / p99 3000, the JSON shape, the
   2000 warm-ups and the alternating rounds are all unchanged. Matches the plan at `1e7e5e8` (FFI-06 gate text
   and risk 19).
2. **README**: the gate is stated as amended, with provenance (Nick, 2026-10-13, risk 19, FFI-01 formula). The
   bounds are arithmetically correct for every run: 10.01, 10.37, 10.23, 11.76, 9.89. The historical
   strict-parity column is kept (FAIL in all five runs). The two stale sentences are listed above.
3. **Catalog test**: `r-w1` ends 16:00:10.000 with 100 ms duration, so the widened start is 09.899.
   - `d12` @ 09.899 is exactly 1 ms before the start, on the inclusive boundary: attributed.
   - `d13` @ 09.898 is 2 ms before the start, with the same trace: unattributed.
   - `d14` @ 09.950 uses trace `dl-other`, the same app and the same span, with a NULL path. It tests the
     trace predicate alone.

   The 11 -> 14 bump is the only existing line changed. Mutations were applied to scratch copies outside the
   repo; no repo file was edited.
   - Unmutated: 15 passed.
   - Trace match removed: FAIL at :414, where `d14` shows up as `app1/w1/null=1`. All earlier assertions still
     pass, so only the new fixture catches this mutation.
   - Lower bound removed: FAIL at :414, where `d13` shows up as `app1/w1/blocking=1`.
   - Extra mutation, `+1` widening dropped from the lower bound: FAIL. `d12` becomes unattributed, and the
     earlier `hits(app1,null,nonblocking)` check catches it.
4. **Validation**:
   - `deno task ci` exit 0: fmt:check and lint clean, check clean, 687 unit tests passed (1 ignored), 79
     property tests passed. The run started at load 1.36 with no other suite running.
   - An earlier ci run, started while another agent's `deno test` was running (load 2.29), failed only
     `tests/unit/document_reader_test.ts:383` on its load-scaled timing bound (median 7.25 ms vs bound 5.33).
     That code is not in the delta, and it passed in the quiet rerun.
   - `deno run -A perf/ffi_read_cost.ts` exit 0 at load 1.09 / 1.31 / 1.57. Results: node p50 / p99 7.09 /
     32.00 us; FFI blocking 7.66 / 30.34 us (amended bound 10.22; PoC budget 10.2); nonblocking 56.96 / 481.45
     us.
5. **Scope**: the delta touches only `perf/ffi_read_cost.ts`, `perf/README.md`,
   `tests/unit/analysis_catalog_test.ts` and `agent-work/items/ffi-06-evidence/brief.md`.
