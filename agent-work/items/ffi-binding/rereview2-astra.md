# FFI-01 independent second-repair re-review

Reviewer: Astra (`gpt-6-astra`), independent of the builders and prior reviewers\
Actor: `astra-rereview2-ffi-01`\
Date: 2026-10-13\
Reviewed SHA: `ca348ea` (`ca348eae7a31257dcc025e1cac3239d7c46e3d2e`) / code `e45b2ae`\
Delta from: `9eec83b`\
Base main: `dedef4f`

Verdict: FAIL

The post-release native reads are repaired, and both prior reproductions now preserve the expected SQLite
errors. The three first-repair invariants still hold. One narrower error-preservation defect remains in the
new cause attachment: it can mutate a caller-owned exception or replace it with another exception. There is
also one formatting nit in the appended brief.

## DEFECTS

1. **Medium — cause attachment is not exception-safe and mistakes error class for ownership.**
   `platform/sqlite_ffi/database.ts:329`–`:334`, called at `:816`. `attachCause` treats every instance of a
   binding error class as belonging to this execution. A parameter getter can instead throw a caller-owned
   `SqliteUsageError` (including one caught from an earlier operation). If that error is extensible, cleanup
   adds `cause`, violating the explicit promise to rethrow caller exceptions untouched. If it is frozen,
   `Object.defineProperty` throws `TypeError`, and the unguarded call at line 816 replaces the primary error
   altogether. `instanceof` also executes a thrown Proxy's `getPrototypeOf` trap, which can throw and replace
   an otherwise unrelated caller exception. These are JavaScript error-handling failures, not native-lifetime
   failures; the connection is released and close waiters still finish.

   **Observed:** a subprocess with both unfrozen and frozen caller errors printed respectively
   `same: true, cause: "cleanup"` and
   `same: false, message: "Cannot define property cause, object is not extensible"`. Both connections
   subsequently read 42. Repeating the frozen case with a throwing detachment **method and getter**, a
   10-second deadline timer, and `closeAsync()` requested inside the parameter getter produced the same
   TypeError replacement in both cases; both close waiters completed. A separate thrown-Proxy probe returned
   the trap's `Error("classification replaced caller")`, not the original object, for both forms of
   detachment.

   Minimal reproduction, run from this worktree with `ulimit -c 0; timeout 10s deno eval '<code>'`:

   ```ts
   import { Database, SqliteUsageError } from "./platform/sqlite_ffi/mod.ts";
   const db = Database.open(":memory:");
   const own = Object.freeze(
     new SqliteUsageError({ reason: "invalid-option", detail: "caller error" }),
   );
   const ac = new AbortController();
   ac.signal.removeEventListener = () => {
     throw new Error("cleanup");
   };
   try {
     await db.prepare("SELECT :x").getAsync({
       get x() {
         throw own;
       },
     }, { signal: ac.signal });
   } catch (e) {
     console.log(e === own, e.name, e.message);
   }
   console.log(db.prepare("SELECT 42 AS x").get());
   db.close();
   ```

   Actual: `false TypeError Cannot define property cause, object is not extensible`; expected: rejection with
   exactly `own`, unchanged. All probes exited 0 under the watchdog; no crash or hang is claimed.

   **Fix must cover:** distinguish caller-origin failures from errors owned by the current execution without
   relying on `instanceof` as proof of ownership, and make any diagnostic attachment incapable of replacing
   the pending failure. Add method/getter cleanup cases for frozen and extensible caller-owned tagged errors
   and an exception whose prototype inspection throws. Assert identity and unchanged own-property descriptors
   for caller exceptions, original fields and non-enumerable cause for execution-owned errors, timer cleanup,
   reuse, and close-waiter settlement. The existing tests cover only an ordinary extensible `Error` as the
   caller's exception and do not expose this gap.

## Formatting nit

`agent-work/items/ffi-binding/brief.md:106` exceeds the formatter's layout: `deno fmt --check` on all six
changed files fails only here, asking to wrap `commit` and `` `e45b2ae`: `` onto separate lines. This is new
in the reviewed delta, separate from the supplied pre-existing repo-wide documentation formatting baseline.
The other five changed files pass. Format the brief in the repair; this nit alone would merit NITS.

## Cleanup mechanism and test assessment

- **Native lifetime repair: passes.** Async step errors are materialized at line 785; cancellation objects are
  created during the execution or the reset phase; successful results, including native changes/rowid reads,
  are materialized at line 787. Reset runs at line 796 and reset errors are copied at lines 801–803 while
  `c.active` still owns the open connection. The `finally` clears the deadline, drops bound copies, clears the
  reservation, and resolves `settled`, in that order. Signal detachment is afterwards at line 813. Success,
  step error, cancellation, reset error, and caller-getter exception all pass through that common cleanup. No
  native call on the old execution's connection or statement follows release on these paths.
- **Sync reset errors: pass.** Lines 678–682 read the error before `#release`; earlier failures are preserved
  through reset/release at lines 671–675. The read-lock/RETURNING regression test covers both paths and
  subsequent statement reuse.
- **Nested cleanup work: safe.** `#release` finishes clearing native copies and `#holdsCopies` before clearing
  `c.active`. A hook may close, close asynchronously, execute synchronously, or restart the same statement
  asynchronously. The old continuation only handles JavaScript outcomes afterwards; it cannot reset, clear
  bindings, or interrupt the new execution. The new subprocess test crosses method/getter detachment with
  seven hooks, including reset-error-state overwrite and same-statement restart. It asserts original
  `SQLITE_BUSY` code 5, extended code 5, and `database is locked`, plus independent nested outcomes and reuse.
- **Waiters: pass.** Settlement follows complete native cleanup and reservation release, with no await or
  caller callback in between. Promise continuations cannot observe a half-released state. `closeAsync`
  rechecks `c.active` after every await, so work started by the hook is cancelled and awaited as a new
  execution. An additional watchdog subprocess requested three concurrent close waiters; detachment restarted
  the same unbounded statement and fired the old signal. Both executions rejected `SqliteCancelled`, all three
  waiters resolved, and the connection was closed with `inFlight: false`.
- **Ordinary error preservation: passes; arbitrary caller exceptions: defect 1.** Both new throwing-cleanup
  tests exercise step, reset, deadline, abort, caller Error, success-with-committed-write, reuse, and close
  waiters. The original duplicate-UNIQUE probe now reports `SqliteError`, extended code 2067, and the cleanup
  cause; an independent descriptor check confirms `cause.enumerable === false`. The cancellation variant
  reports `SqliteCancelled`, reason `deadline`, with its cleanup cause. The missing distinction is the
  provenance of an arbitrary caught exception.

## Assessment of the three design choices

1. **Allow nested work after release: acceptable.** Native ownership has ended completely before invoking the
   hook. Keeping the connection busy through caller cleanup would also be a possible contract, but is not
   needed for safety here. The rechecking close loop accommodates a newly started execution. Repeatedly
   starting more work can delay close, as permitted by the current API; this is not a half-release race.
2. **Success plus cleanup throw rejects with typed `signal-cleanup`, although the write stands: acceptable.**
   It reports a caller hook failure explicitly, distinguishes it from a SQLite execution failure, and
   documents that changes were not rolled back in both the error definition and error detail. Returning
   success would discard that failure. Callers must not treat this reason as permission to retry a committed
   write; no automatic retry contract is introduced by this item. The test explicitly proves the row remains
   committed.
3. **Drop cleanup exceptions when the pending failure belongs to the caller: acceptable policy.** Preserving
   exact identity and state avoids modifying arbitrary/frozen error objects and honors the primary-error
   contract. Losing a secondary diagnostic is an intentional tradeoff. The policy is sound; the implementation
   does not fulfill it for tagged or Proxy exceptions, which is defect 1, rather than a defect in the choice.

## Whole-item sanity pass

The first repair's invariants remain intact. Both execution paths reserve the connection before parameter
accessors, array/proxy operations, option getters, or signal operations. Async cancellation immediately
interrupts and repeats every 1 ms until the outstanding step promise settles, covering native dispatch before
entry. The step's `finally` clears the interval and sets `inStep = false` synchronously before reset/release.
The deadline is cleared before release; a retained old abort listener can only mark its old, non-stepping
execution cancelled. No interrupt from that execution reaches a subsequent statement. Existing step/cancel
errors win over a reset rc; otherwise reset errors are checked and copied before further native cleanup.

The three focused runs re-exercise the first two crashing entry probes, the 6-by-11 nested-entry matrix,
locked-reader reset failure/reuse, and the cancellation race subprocess (100 immediate aborts, 50 zero-delay
deadlines, 50 immediate closes, and 16 simultaneous connections) each time. No regression in those invariants
was found. The 16-connection probe applies dispatch pressure; it does not establish blocking-pool saturation.

The sole nonblocking symbol still accepts only a SQLite-owned statement pointer; synchronous out-parameter
scratch never crosses that boundary. FULLMUTEX, library thread-safety/version checks, TRANSIENT text/blob
copies, lossless text decoding, copied blob results, integer range checks, explicit statement ownership and
loaded-library retention are intact. The performance test opens separate files for the two SQLite copies.
`Deno.dlopen` occurs only in `platform/sqlite_ffi/library.ts:109`; no UnsafeCallback was found. Boundaries
pass unchanged. No FFI-03 migration, cache, autocommit API, or core-error-taxonomy work is counted as missing
here. FFI-01's explicit as-built 3.37/path-list contract takes precedence over the older general plan wording.

## Checks run

Environment: Deno 2.9.5, V8 15.0.245.2-rusty, TypeScript 6.0.3; loaded
`/usr/lib/x86_64-linux-gnu/libsqlite3.so.0`, SQLite 3.45.1. `PATH` includes `$HOME/.deno/bin`.

- `git diff --stat 9eec83b..ca348ea`: exactly six allowed files, 365 insertions and 41 deletions.
  `database.ts` is the implementation change; `errors.ts` is additive in API (the replaced union terminator
  accommodates the new reason); both tests add cases, with one import adjustment; gotchas and brief only
  append. No ownership violation. `git diff --check` passed. Product tree initially clean.
- `deno task lint`: passed, 159 files. `deno task check`: passed (also independently repeated with exit 0).
  Focused tests type-check the new FFI modules as well.
- `deno fmt --check` over all six changed files: failed only on the brief, as recorded above. Repo-wide
  `fmt:check` was not rerun; the supplied out-of-scope baseline is not attributed to this item.
- Required focused command:
  `deno test --v8-flags=--expose-gc -A tests/unit/sqlite_ffi_crud_test.ts tests/unit/sqlite_ffi_cancel_test.ts tests/unit/sqlite_ffi_perf_test.ts tests/unit/boundaries_test.ts`:
  **34 passed, 0 failed, three times** (18 CRUD, 9 cancellation, 1 performance, 6 boundaries), in **12 / 14 /
  12 seconds**.
- Both second-report reproductions, separately under `ulimit -c 0; timeout 10s deno eval`: exit 0. Reset probe
  prints `cleanup closes false` followed by `SqliteError reset 5 5 database is locked`; duplicate UNIQUE probe
  preserves extended code 2067 and subsequent read 42. The additional deadline variant also exits 0,
  preserving `SqliteCancelled` and reuse. Additional defect and three-waiter probes are detailed above.
- `deno task test`: **639 passed, 0 failed, 1 ignored (6m22s)**, exit 0. Initial load **1.35 / 1.15 / 1.59**.
  Both previously reported flaky files passed in this full run; no isolated rerun was needed. The ignored case
  is the opt-in real-S3 backup test.
- `deno task test:prop`: **79 passed, 0 failed (5m3s)**, exit 0. Initial load **1.56 / 1.35 / 1.62**, default
  seed **20261010**. The full and property tasks overlapped after the focused runs; sampled load during their
  overlap reached **3.72 / 2.58 / 2.06**. These are observations, not a claim about peak host load.

Times below are milliseconds unless labeled otherwise. Load is `uptime`'s 1/5/15-minute load average sampled
immediately before each focused invocation. Full/property tasks were started after all three focused runs.

| Run | Load               | Five deadline latencies           | Median | Abort observed / reported | Four concurrent latencies | closeAsync |
| --- | ------------------ | --------------------------------- | ------ | ------------------------- | ------------------------- | ---------- |
| 1   | 0.88 / 0.98 / 1.59 | 0.777, 0.187, 0.164, 0.208, 0.202 | 0.202  | 3.096 / 0.416             | 0.29, 0.28, 0.16, 0.19    | 0.514      |
| 2   | 0.94 / 1.02 / 1.57 | 0.890, 0.416, 0.140, 0.371, 0.416 | 0.416  | 5.559 / 0.593             | 0.15, 0.28, 0.25, 0.31    | 0.384      |
| 3   | 1.26 / 1.11 / 1.58 | 1.144, 0.373, 0.298, 0.317, 0.382 | 0.373  | 3.281 / 0.359             | 0.25, 0.42, 0.27, 0.27    | 0.774      |

| Run | Immediate abort median / max (100) | Deadline 0 median / max (50) | Immediate close median / max (50) | 16 connections settled |
| --- | ---------------------------------- | ---------------------------- | --------------------------------- | ---------------------- |
| 1   | 0.941 / 14.768                     | 0.185 / 2.822                | 1.810 / 13.538                    | 1.834                  |
| 2   | 0.526 / 8.512                      | 0.169 / 5.374                | 2.440 / 8.048                     | 4.690                  |
| 3   | 0.462 / 9.281                      | 0.167 / 1.664                | 2.547 / 8.853                     | 5.349                  |

Deadline loop ticks were 70–74 / 61–69 / 65–74, maximum gaps 14.5 / 13.0 / 13.4 ms, point reads 52–56 / 46–53
/ 50–57. Four-connection totals were 162.5 / 169.1 / 162.4 ms, ticks 63 / 49 / 63, maximum gaps 6.0 / 8.9 /
8.1 ms. Every latency and responsiveness gate passed.

| Run | node:sqlite p50 / p99 µs | FFI sync p50 / p99 µs | FFI nonblocking p50 / p99 µs |
| --- | ------------------------ | --------------------- | ---------------------------- |
| 1   | 8.030 / 41.146           | 8.097 / 43.960        | 84.760 / 1524.937            |
| 2   | 8.201 / 45.081           | 8.157 / 43.238        | 87.306 / 2567.320            |
| 3   | 7.959 / 38.471           | 7.896 / 35.376        | 97.742 / 1423.454            |

Each parity run measured 24,000 reads per sync path and 2,000 nonblocking reads; parity passed three times.

Learning assessment: the cleanup-ordering lesson is captured in gotchas; add that error class does not prove
ownership and diagnostic annotation must never replace a pending exception.
