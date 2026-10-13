# FFI-01 independent third-repair re-review

Reviewer: Astra (`gpt-6-astra`), independent of the builders and prior reviewers\
Actor: `astra-rereview3-ffi-01`\
Date: 2026-10-13\
Reviewed SHA: `9250359` (`9250359fae43c09844ef2fc24a3e7b82617d2ef7`) / code `b08d5a2`\
Delta from: `ca348ea`\
Base main: `dedef4f`

Verdict: PASS

## DEFECTS

None (0). The third repair satisfies the second re-review's “Fix must cover” acceptance criterion.

## NITS / notes

No actionable nit identified in the repair. The prior brief formatting nit is fixed. Repo-wide formatting was
not rerun; the supplied pre-existing documentation failures outside this item are excluded.

## Mechanism and acceptance assessment

1. **Ownership is identity, not class.** `database.ts:335` defines `Own`; the async execution's local recorder
   at `:765` saves exactly the object about to be thrown. The gate at `:841` uses
   `ownError !== undefined && failure === ownError`. No prototype check, property access or mutation is
   performed on an arbitrary pending caller exception. The exception is stored and thrown as an opaque value.
   An error from a nested caller operation remains caller-owned relative to this execution.
2. **Recorder coverage is complete for pending binding-created failures.** Option validation, pre-aborted
   signals, between-step cancellation, interrupted-step cancellation, native step errors, reset errors and
   reset cancellation use `own`. `#bind` passes it through count/name validation and `#bindValue`, including
   integer range, unsupported value and native bind rc errors; `#readRow` records unsafe integer failures. The
   sync helpers default to the no-op `unrecorded`. Preflight busy/closed/finalized failures occur before an
   execution or signal cleanup exists. The cleanup-only `signal-cleanup` error is created with its cause
   directly and needs no subsequent recording. No missed recorder path that would lose a cleanup cause was
   found.
3. **Caller coercion does not claim ownership.** Timeout diagnostic interpolation is explicitly completed
   before `own`; other interpolations and error construction are arguments evaluated before the recorder runs.
   An exception during array-length or timeout coercion therefore remains opaque. Independent probes for both
   paths, crossed with method/getter detachment, preserve the thrown Proxy with zero traps.
4. **Attachment cannot replace the pending error.** Both `Object.hasOwn` and `Object.defineProperty` are
   inside `attachCause`'s `try`/`catch` (`:344`). Annotation is non-enumerable and best effort. Independent
   subprocess probes made each operation throw during attachment, captured the execution-owned error, and
   verified that exact object still rejected with its original `bind-count` reason and a reusable connection.
5. **Earlier resource and outcome guarantees remain intact.** Both paths reserve before caller input; async
   repeats interrupts until the outstanding step settles, then synchronously clears the interval and `inStep`.
   Reset rc is checked, and native error fields and successful results are materialized before release.
   Deadline clearing, native-copy clearing, reservation release and waiter settlement precede detachment. No
   native access by this execution follows release. A retained listener cannot interrupt a later execution
   because its old `inStep` is false. Pending failures beat reset rc and throwing cleanup; success plus
   throwing cleanup remains typed `signal-cleanup`, with committed changes standing. `closeAsync` rechecks
   active work after every await. These paths retain the earlier subprocess regression coverage for entry
   reentrancy, reset failure, detachment closing/reusing/restarting work and cancellation dispatch races.

The new method/getter tests assert frozen and extensible tagged-error identity and unchanged own-property
descriptors, zero traps on a thrown Proxy, reuse, and close-waiter settlement when close is requested inside
the parameter getter. Their 10-second timers run under Deno's timer/resource sanitizers. Execution-owned error
tests assert original fields and a non-enumerable cause for cancellation, reset, step, bind validation, option
validation and unsafe integer reads. The single recorder is sufficient: recording immediately precedes
throw/assignment, and reset does not replace an existing failure.

Whole-item sanity: the nonblocking symbol takes only the SQLite-owned statement pointer; synchronous scratch
does not cross it. FULLMUTEX, thread-safety/version validation, TRANSIENT text/blob copies, lossless text and
copied blob reads, integer checks and loaded-library retention remain intact. The parity test uses separate
files for the two SQLite copies. `Deno.dlopen` appears only at `platform/sqlite_ffi/library.ts:109`; no
UnsafeCallback was found under `platform/`. The explicit FFI-01 as-built version/path contract applies; later
migration, cache and core-error work is outside this item.

## Checks run

Environment: Deno 2.9.5, V8 15.0.245.2-rusty, TypeScript 6.0.3; loaded
`/usr/lib/x86_64-linux-gnu/libsqlite3.so.0`, SQLite 3.45.1. Commands used `PATH="$HOME/.deno/bin:$PATH"`.

- `git diff --stat ca348ea..9250359`: four allowed files, 250 insertions and 57 deletions: `database.ts`,
  `sqlite_ffi_cancel_test.ts`, additive `docs/knowledge/gotchas.md`, and `brief.md` (append plus prior
  formatting fix). No ownership violation. `git diff --check` passed; initial tree clean.
- `deno task lint`: passed, 159 files. `deno task check`: passed. The focused command also type-checks the
  binding and its tests.
- `deno fmt --check` on all four changed files: passed. Separate `deno fmt --check` on `brief.md`: passed.
- Required focused command:
  `deno test --v8-flags=--expose-gc -A tests/unit/sqlite_ffi_crud_test.ts tests/unit/sqlite_ffi_cancel_test.ts tests/unit/sqlite_ffi_perf_test.ts tests/unit/boundaries_test.ts`:
  **36 passed, 0 failed, three times**, in **13 / 12 / 13 seconds** (18 CRUD, 11 cancellation, 1 performance,
  6 boundaries).
- Prior report's exact frozen-error reproduction under `ulimit -c 0; timeout 10s deno eval`: exit 0; printed
  `true SqliteUsageError` (empty message), then `{ x: 42 }`. The pending error is preserved.
- Independent watchdog matrix: **12 cases passed**, exit 0. Method/getter detachment crossed with
  frozen/extensible tagged errors and a Proxy whose traps throw, each with reuse or `closeAsync` requested
  inside the getter. Exact rejection identity, unchanged descriptors, zero Proxy traps, cleared in-flight
  state, sync/async reuse and completed close waiters were asserted. Each execution used a 10-second deadline,
  yet the entire subprocess exited in under one second.
- Additional watchdog probes: timeout/array-length diagnostic coercion preserves opaque thrown Proxies;
  omitted parameters, unknown names, missing named binds and pre-aborted execution retain their own cause;
  failed `hasOwn`/`defineProperty` annotation preserves exact pending identity. All exited 0 and reused their
  connections. Temporary built-in overrides in the annotation probe were restored in `finally`.
- `deno task test`: **641 passed, 0 failed, 1 ignored (5m42s)**, exit 0. Both previously flaky files
  (`ipc_test.ts`, `number_dialects_test.ts`) passed in the full run; no isolated reruns were needed. The
  ignored case is the opt-in real-S3 backup test.
- `deno task test:prop`: **79 passed, 0 failed (4m10s)**, exit 0; default seed **20261010**. Full and property
  tasks started together after the focused runs, with load **1.07 / 1.11 / 1.55**. A sample during overlap was
  **4.78 / 2.63 / 2.06**; a later full-suite sample was **2.38 / 2.62 / 2.17**. These are sampled
  observations, not peak-load claims.

Times below are milliseconds unless labeled otherwise. Load is the `uptime` 1/5/15-minute average sampled
immediately before each focused invocation. The full/property suites started after all three focused runs; the
small independent reproduction probes overlapped part of the focused runs.

| Run | Load               | Five deadline latencies           | Median | Abort observed / reported | Four concurrent latencies | closeAsync |
| --- | ------------------ | --------------------------------- | ------ | ------------------------- | ------------------------- | ---------- |
| 1   | 0.55 / 1.04 / 1.56 | 0.624, 0.253, 0.243, 0.322, 0.214 | 0.253  | 6.692 / 2.012             | 0.24, 0.30, 0.22, 0.22    | 0.356      |
| 2   | 0.74 / 1.05 / 1.55 | 0.610, 0.255, 0.404, 0.168, 0.304 | 0.304  | 3.987 / 0.434             | 0.30, 0.27, 0.24, 0.27    | 0.370      |
| 3   | 0.86 / 1.07 / 1.55 | 2.224, 0.350, 0.120, 0.174, 0.266 | 0.266  | 3.066 / 0.407             | 0.21, 0.38, 0.17, 0.30    | 0.340      |

| Run | Immediate abort median / max (100) | Deadline 0 median / max (50) | Immediate close median / max (50) | 16 connections settled |
| --- | ---------------------------------- | ---------------------------- | --------------------------------- | ---------------------- |
| 1   | 0.318 / 13.463                     | 0.186 / 2.506                | 1.640 / 3.938                     | 2.009                  |
| 2   | 0.347 / 4.798                      | 0.168 / 1.581                | 1.917 / 8.612                     | 8.654                  |
| 3   | 0.333 / 21.093                     | 0.175 / 0.620                | 1.654 / 2.844                     | 9.954                  |

Deadline loop ticks were 57–76 / 71–78 / 65–78; maximum gaps 50.6 / 12.6 / 11.5 ms; point reads 49–57 / 55–59
/ 46–60. Four-connection totals were 163.4 / 162.8 / 164.1 ms, ticks 63 / 63 / 67, maximum gaps 6.9 / 4.6 /
6.0 ms. All latency and responsiveness gates passed. The 16-connection race case exerts dispatch pressure; it
does not establish blocking-pool saturation.

| Run | node:sqlite p50 / p99 µs | FFI sync p50 / p99 µs | FFI nonblocking p50 / p99 µs |
| --- | ------------------------ | --------------------- | ---------------------------- |
| 1   | 8.168 / 40.142           | 8.378 / 39.205        | 70.696 / 993.425             |
| 2   | 8.159 / 43.567           | 7.872 / 46.234        | 60.557 / 484.538             |
| 3   | 8.066 / 38.702           | 8.130 / 39.126        | 57.073 / 525.833             |

Each parity run measured 24,000 reads per sync path and 2,000 nonblocking reads; all passed.

Learning assessment: the additive gotcha correctly captures identity-based ownership, opaque caller exceptions
and exception-safe diagnostic attachment; no additional durable lesson needs a product-tree edit.
