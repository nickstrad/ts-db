# FFI-01 independent repair re-review

Reviewer: Astra (`gpt-6-astra`), independent of the builder and original reviewer\
Actor: `astra-rereview-ffi-01`\
Date: 2026-10-13\
Reviewed SHA: `9eec83b` (`9eec83b4c2dc23657d7d73a4610d9af9ef397e03`)\
Delta from: `acdef43`\
Base main: `dedef4f`

Verdict: FAIL

The dispatch-to-entry cancellation repair passes. The original two crashing entry probes and the ordinary
reset-error scenario are repaired. Two remaining defects in async signal cleanup prevent a resource-safety and
error-preservation pass. The required focused suite passes three times; these findings come from additional
isolated probes and the cleanup mechanism, not from failing existing tests.

## DEFECTS

1. **Blocking — async reset-error reporting accesses a connection after caller cleanup can close it.**
   `platform/sqlite_ffi/database.ts:710`–`:713`, `:764`–`:768`, and `:292`–`:295`. `finish()` resets and
   clears `c.active`, then invokes caller-controlled `signal.removeEventListener`. Contrary to the comment at
   `:706`, native work remains: when reset failed, `sqliteError(c, "reset", rc, ...)` subsequently calls
   `sqlite3_extended_errcode(c.db)` and `sqlite3_errmsg(c.db)`. A perfectly ordinary override on a real
   AbortSignal can call `db.close()` here; close succeeds, finalizes the statements and frees the connection
   before those error reads. An override that executes another statement can instead overwrite the error state
   or start another native execution before the old execution reads it. This leaves original defect 2's
   lifetime guarantee incomplete and undermines defect 3's error snapshot.

   **Observed:** the following subprocess exited 0, printed `cleanup closes false`, then
   `SqliteError reset 5 5 bad parameter or other API misuse`. The expected reset error was a locked database;
   the misuse message came from querying the closed handle. No segfault is claimed for this run; the two
   post-close native calls are established directly by the control flow. Undefined handle use is blocking
   regardless of whether this allocation happens to crash.

   Run with `ulimit -c 0; timeout 10s deno eval '<code below>'`:

   ```ts
   import { Database } from "./platform/sqlite_ffi/mod.ts";
   const dir = Deno.makeTempDirSync();
   const a = Database.open(dir + "/t.db");
   const b = Database.open(dir + "/t.db");
   try {
     a.exec("CREATE TABLE t(x); INSERT INTO t VALUES(1)");
     b.exec("BEGIN; SELECT * FROM t");
     const ac = new AbortController();
     ac.signal.removeEventListener = function () {
       console.log("cleanup closes", a.inFlight);
       a.close();
     };
     try {
       await a.prepare("INSERT INTO t VALUES(2) RETURNING x")
         .getAsync(undefined, { signal: ac.signal });
     } catch (e) {
       console.log(e._tag, e.op, e.code, e.extendedCode, e.sqliteMessage);
     }
   } finally {
     b.close();
     a.close();
     Deno.removeSync(dir, { recursive: true });
   }
   ```

   **Fix must cover:** finish all native error reads and materialize the pending error while the execution
   still owns an open connection, before invoking any signal cleanup getter/method. Preserve release and
   waiter settlement on every exit. Add subprocess coverage for reset failure combined with cleanup that
   closes, performs a sync call, or starts an async call. Either refuse nested work while ownership is held or
   allow it only after no native access remains. Verify the original reset code, extended code and message
   survive without using a closed handle or blocking on the next execution.

2. **High — throwing signal cleanup replaces the original step or cancellation error.**
   `platform/sqlite_ffi/database.ts:712` and `:759`–`:762`. The catch path calls `finish()` before `throw e`.
   If the `removeEventListener` getter or method throws, `throw e` is never reached. This contradicts the
   repair's explicit requirement to preserve an existing step/cancel error. It is distinct from defect 1: even
   after moving all native error reads before cleanup, an unguarded cleanup exception will still erase the
   primary failure.

   **Observed:** with a real AbortSignal whose `removeEventListener` throws
   `Error("cleanup replaced original")`, an async duplicate UNIQUE insert rejected that untagged Error, not
   `SqliteError` with the constraint's extended code. Repeating with an unbounded recursive CTE and
   `timeoutMs: 5` rejected `Error("cleanup replaced cancellation")`, not `SqliteCancelled`. Both probes ran
   under `timeout 10s` with core dumps disabled, exited 0, printed `inFlight: false`, and successfully read 42
   afterwards. Thus release works, but primary-error preservation does not.

   Minimal step-error probe, under the same subprocess command:

   ```ts
   import { Database } from "./platform/sqlite_ffi/mod.ts";
   const db = Database.open(":memory:");
   db.exec("CREATE TABLE t(x UNIQUE); INSERT INTO t VALUES(1)");
   const ac = new AbortController();
   ac.signal.removeEventListener = function () {
     throw new Error("cleanup replaced original");
   };
   try {
     await db.prepare("INSERT INTO t VALUES(1)").runAsync(undefined, { signal: ac.signal });
   } catch (e) {
     console.log({ tag: e._tag, message: e.message, inFlight: db.inFlight });
   }
   console.log(db.prepare("SELECT 42 AS x").get());
   db.close();
   ```

   **Fix must cover:** make cleanup exception-safe and ensure a pending step, cancellation or reset error wins
   over an error thrown by signal detachment. Exercise both a throwing property getter and a throwing method;
   verify the original error fields, cleared timers, released connection, resolved close waiters, and
   successful reuse. Define cleanup-only failure behavior without losing the primary failure.

## Assessment of the three original repairs

1. **Cancel race: resolved.** `cancel` starts immediate and repeated interrupts only with an outstanding step;
   its interval persists across the native dispatch window. The `finally` directly following the awaited step
   synchronously clears that interval and marks `inStep = false`, before reset or release. No caller callback
   or await intervenes there. Between steps the cancellation flag prevents submitting another step.
   Consequently timer callbacks cannot reach a later execution. `closeAsync` awaits release, which occurs
   after step settlement and reset; queued immediate-close trials all terminated.

   These semantics agree with SQLite's [interrupt contract](https://www.sqlite.org/c3ref/interrupt.html):
   calls made with no running statement do not affect later statements, and interrupt scope ends when the
   active-statement count returns to zero. The implementation need not rely on the flag's physical bit being
   cleared at the instant reset returns. Reset retires any partially consumed statement before reuse.
   `loadLibrary().version` in this worktree reports **3.45.1**. The race tests exercise that library. The
   16-connection case increases dispatch pressure but does not instrument or prove blocking-pool saturation;
   correctness across an arbitrarily queued step follows from retaining the interval until settlement.

2. **Entry reentrancy: repaired; cleanup reentrancy: incomplete (defect 1).** Both sync and async statement
   paths reserve before `#bind`, including `Array.isArray`, array length/index reads, named `Object.keys`
   proxy traps and named value getters. Async reservation also precedes option reads, timeout validation and
   diagnostic coercion, `signal.aborted`, and signal registration. SQL coercion in `exec`/`prepare` precedes
   their final lifetime check. No remaining caller-input evaluation before reservation was found in the
   reviewed execution entry paths. `#finish` skips reset if finalized.

   `SYNC_EXECUTION` is a shared singleton, introduces no per-call allocation, has a no-op cancel and an
   already-resolved promise. A reentrant `closeAsync` yields at that promise until the synchronous stack has
   reset and released; it then rechecks the actual `c.active`, so a subsequently started async execution is
   cancelled and awaited as itself. The existing matrix verifies sync-close deferral and async-close
   cancellation. It omits signal-detachment reentrancy, where the remaining lifetime gap occurs.

3. **Reset handling: ordinary cases repaired; callback combinations incomplete (defects 1 and 2).** Sync and
   async successful executions check reset's rc, report `op: "reset"`, and use the extended-code helper. An
   interrupted reset with `exec.cancelled` takes the `SqliteCancelled` branch. Earlier step/cancel errors win
   over reset's repeated rc with normal signal cleanup. Cleanup clears bindings and releases even when reset
   fails. The successful-path sync change adds a singleton assignment, local result and rc check, not a new
   per-call object/closure/promise. The [SQLite reset contract](https://www.sqlite.org/c3ref/reset.html)
   explicitly requires checking errors after the first RETURNING row; the ordinary locked-reader case now does
   so correctly. Custom signal cleanup still defeats the guarantees as demonstrated above.

## Checks run

- `git diff --stat acdef43..9eec83b`: exactly the six allowed files; 546 insertions, 54 deletions.
  `database.ts` is the only file with deletions. `errors.ts` adds the reset operation; gotchas adds 25 lines;
  the brief appends 31 lines. Both test changes are additive. `deno.json` is untouched.
- `git diff --check acdef43..9eec83b`: passed. Product working tree was clean before report creation.
- `deno task lint`: passed, 159 files. `deno task check`: passed.
- `deno fmt --check` on all six changed files: passed, 6 files.
- Three runs of
  `deno test --v8-flags=--expose-gc -A tests/unit/sqlite_ffi_crud_test.ts tests/unit/sqlite_ffi_cancel_test.ts tests/unit/sqlite_ffi_perf_test.ts tests/unit/boundaries_test.ts`:
  **31 passed, 0 failed each** (17 CRUD, 7 cancellation, 1 performance, 6 boundaries), 12/13/11 seconds. This
  includes the new `race:` subprocess three times and the reset/reentrancy tests three times.
- Original 100-immediate-abort reproduction, separately under `timeout 10s`: **100/100 SqliteCancelled**, max
  observed abort-to-settlement **4.687 ms**, clean close and exit 0, no rescue interrupt.
- Original two reentrancy probes, separately under `timeout 10s deno eval`, `ulimit -c 0`: both produce
  **SqliteUsageError busy**, exit 0, and subsequent reads return 5 and 1 respectively.
- Additional subprocess input probes: named ownKeys proxies and positional length proxies on both paths,
  `signal.aborted`, signal registration method, and invalid timeout's diagnostic coercion all refuse nested
  close with typed busy; every connection remains reusable. Revoked array proxies throw their native TypeError
  on both paths and still release cleanly for reuse.
- Separate locked-reader INSERT RETURNING probe with `busyTimeoutMs: 0`: sync and async each reject
  **SqliteError, op reset, code 5, extendedCode 5**, and report `inFlight: false`. After reader rollback, the
  same statement succeeds on both paths; rows are `[1, 2, 3]`.
- Additional cleanup probes reproduced defects 1 and 2 as recorded above, all under external watchdogs.
- `rg -n 'Deno.dlopen' platform`: only `platform/sqlite_ffi/library.ts:109`.
- Full suite, property suite and repo-wide fmt were not rerun in this delta review. No claim that those checks
  are newly green; the supplied out-of-scope formatting baseline and prior full-suite flakes remain separate
  from these findings.

Times below are milliseconds unless labeled otherwise. Load is `uptime`'s 1/5/15-minute average immediately
before each focused invocation.

| Run | Load               | Five deadline latencies           | Median | Abort observed / reported | Four concurrent latencies | closeAsync |
| --- | ------------------ | --------------------------------- | ------ | ------------------------- | ------------------------- | ---------- |
| 1   | 1.94 / 2.24 / 2.68 | 1.015, 0.324, 0.169, 0.280, 0.255 | 0.280  | 2.696 / 0.316             | 0.33, 0.37, 0.21, 0.17    | 0.535      |
| 2   | 1.81 / 2.20 / 2.66 | 0.789, 0.311, 0.167, 0.245, 0.261 | 0.261  | 3.345 / 0.434             | 0.30, 0.50, 0.23, 0.23    | 0.628      |
| 3   | 1.70 / 2.15 / 2.63 | 0.866, 0.298, 0.225, 0.193, 0.283 | 0.283  | 2.841 / 0.350             | 0.84, 0.42, 0.25, 0.22    | 0.382      |

| Run | Immediate abort median / max (100) | Deadline 0 median / max (50) | Immediate close median / max (50) | 16 connections settled |
| --- | ---------------------------------- | ---------------------------- | --------------------------------- | ---------------------- |
| 1   | 0.337 / 4.942                      | 0.155 / 2.623                | 2.059 / 5.577                     | 3.127                  |
| 2   | 0.572 / 8.929                      | 0.166 / 0.375                | 2.536 / 11.707                    | 1.708                  |
| 3   | 0.425 / 5.517                      | 0.158 / 5.713                | 1.912 / 3.432                     | 1.530                  |

Deadline loop probes: ticks 70–76 / 77–79 / 72–75, maximum gaps 11.2 / 6.0 / 7.8 ms, point reads 53–57 / 57–60
/ 52–59. Four-connection totals 163.2 / 162.2 / 163.1 ms, ticks 62 / 63 / 61, max gaps 5.4 / 5.3 / 4.9 ms. All
test latency and responsiveness gates passed.

| Run | node:sqlite p50 / p99 µs | FFI sync p50 / p99 µs | FFI nonblocking p50 / p99 µs |
| --- | ------------------------ | --------------------- | ---------------------------- |
| 1   | 8.133 / 43.626           | 7.947 / 35.522        | 74.888 / 1161.542            |
| 2   | 8.056 / 40.242           | 8.279 / 40.098        | 51.789 / 565.064             |
| 3   | 8.162 / 35.764           | 8.357 / 36.298        | 55.288 / 771.610             |

Each parity run measures 24,000 reads per sync path and 2,000 nonblocking reads; parity passed three times.

Learning assessment: the new gotchas entry captures the original traps; extend its lifetime rule through
native error snapshotting and exception-safe signal detachment, not just bind/step/reset.
