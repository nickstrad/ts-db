# FFI-01 independent review

Reviewer: Astra (`gpt-6-astra`), actor `astra-review-ffi-01`\
Date: 2026-10-13\
Reviewed SHA: `acdef43` (`acdef439e7d285e5568dfd57e3e8945becba835c`)\
Base: `main` at `dedef4f` (`dedef4f553458cd87ae7ccfe790a5538189b6f00`)

Verdict: FAIL

## DEFECTS

1. **Blocking — cancellation can miss a queued native step and hang indefinitely.**
   `platform/sqlite_ffi/database.ts:615` and `:646` (also `closeAsync` at `:435`). `inStep` becomes true
   before the pool thread actually enters SQLite. An immediate abort or `closeAsync()` can therefore call
   `sqlite3_interrupt` while no statement is running. SQLite discards that interrupt; the subsequently started
   unbounded step never returns. The cancellation flag prevents another interrupt (`:616`), and the loop
   cannot inspect the flag until the awaited step completes. A deadline firing while the step is queued has
   the same race. This violates acceptance criteria 2 and 5: cancellation must stop execution, and
   asynchronous close must finish after stopping it.

   Reproduced using only in-memory databases and the public API: 100 immediate-abort iterations under
   `timeout 10s` printed only `0 SqliteCancelled`, then timed out (exit 124). A diagnostic repeat with a
   separate rescue `db.interrupt()` after 100 ms found **7 of 10** immediate aborts still in flight; those
   completed only after rescue (106.05–117.14 ms). Immediate `closeAsync()` needed the same rescue in **4 of
   10** iterations (102.28–114.42 ms). The normal six-test cancellation suite passes because it mostly
   interrupts queries that have already been running for 50–200 ms; its one immediate-close attempt is not
   sufficient to expose this race reliably.

   Minimal reproduction (run in a subprocess with an external timeout):

   ```ts
   import { Database } from "./platform/sqlite_ffi/mod.ts";
   const db = Database.open(":memory:");
   const st = db.prepare(
     "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT count(*) FROM c",
   );
   for (let i = 0; i < 100; i++) {
     const ac = new AbortController();
     const p = st.getAsync(undefined, { signal: ac.signal }).catch((e) => e);
     ac.abort();
     console.log(i, (await p)._tag);
   }
   await db.closeAsync();
   ```

   Fix must cover the dispatch-to-entry window, rather than equating an outstanding FFI promise with native
   execution. Keep cancellation effective until the submitted step has settled, without allowing an interrupt
   to affect the next execution. Verify repeated immediate aborts and immediate closes, cancellation while
   pool work is queued, typed rejection, post-cancel reuse, and no remaining native work after close, all
   under an external watchdog. SQLite explicitly documents that an interrupt with no running statements has no
   effect on later statements: [sqlite3_interrupt](https://www.sqlite.org/c3ref/interrupt.html).

2. **Blocking — reentrant getters bypass lifetime guards and cause native use-after-free.**
   `platform/sqlite_ffi/database.ts:556`, `:592`, and `:707`. The synchronous execution checks usability only
   before reading caller-controlled parameters and never reserves the connection. A legal parameter getter can
   finalize the statement or close the database, after which bind/step/reset uses the freed pointer. The async
   path also reads option getters after its usability check but before reserving the connection
   (`c.active = exec` at `:625`), with the same result. These are ordinary type-correct getter properties, not
   forged native pointers or access to internal state. This violates acceptance criteria 4 and 5: contract
   breaches must produce typed errors, and no execution may use freed handles.

   Both following probes, independently run through `timeout 10s deno eval` with `ulimit -c 0`, exited **139
   (SIGSEGV)** after printing the getter's diagnostic:

   ```ts
   import { Database } from "./platform/sqlite_ffi/mod.ts";
   const db = Database.open(":memory:");
   const st = db.prepare("SELECT :x AS x");
   st.get({
     get x() {
       st.finalize();
       return 1;
     },
   });
   ```

   ```ts
   import { Database } from "./platform/sqlite_ffi/mod.ts";
   const db = Database.open(":memory:");
   const st = db.prepare("SELECT 1 AS x");
   await st.getAsync(undefined, {
     get timeoutMs() {
       db.close();
       return 100;
     },
   });
   ```

   Establish exclusive ownership before executing caller code, or fully snapshot inputs and revalidate
   lifetimes before using any pointer. Cover both sync and async entry paths; cleanup must not reset a
   statement finalized during input handling. Verify these probes in isolated subprocesses, plus getters that
   attempt nested execution/prepare/close/finalize and positional-array accessors. They must produce a typed
   usage error without crashing, blocking the event loop, or allowing overlapping executions.

3. **Blocking — ignored reset errors report successful writes that were rolled back.**
   `platform/sqlite_ffi/database.ts:578` and `:668` (the early exits for `get` are at `:570` and `:657`).
   `get()` and `getAsync()` stop at the first row, then discard the result of `sqlite3_reset`. For
   `INSERT ... RETURNING`, the first step can yield a row before the implicit transaction commits; resetting
   can fail with `SQLITE_BUSY` and roll the insert back. The caller nevertheless receives the returned row as
   success. This violates acceptance criterion 4 (CRUD correctness and typed failures), and can silently lose
   an apparently successful write.

   Reproduced with two connections through the same FFI library, a fresh temporary database in default
   rollback-journal mode, and `busyTimeoutMs = 0`: `a` creates `t(x)` containing `1`; `b` executes
   `BEGIN; SELECT * FROM t` and holds its read lock; `a.prepare("INSERT INTO t VALUES(2) RETURNING x").get()`
   returns `{ x: 2 }`. After `b.exec("ROLLBACK")`, reading `t` through `a` yields only `{ x: 1 }`. A separate
   fresh-database probe of `getAsync()` produced exactly the same false success and lost row. Each temporary
   database was removed after both connections closed. SQLite documents this exact first-row/reset failure
   case: [sqlite3_reset](https://www.sqlite.org/c3ref/reset.html).

   Check reset's return code on otherwise-successful executions and translate it into the binding's typed
   SQLite error, preserving an original step/cancellation error when reset merely repeats it. Ensure cleanup
   and connection release still happen if reset fails. Verify both sync and async `get` with
   `INSERT ... RETURNING` under a second connection's read lock: reject with `SqliteError` carrying
   `SQLITE_BUSY`, never return the rolled-back row, then successfully reuse the statement and connection once
   the reader releases the lock.

## Checks and acceptance evidence

- Reviewed all 12 changed files against the brief, claims, FFI-01 and plan sections 1.2, 1.3 and 2. All
  changed paths are in Owns. The INDEX change adds one substantive row plus table alignment; gotchas adds the
  two claimed entries. `deno.json` and `tests/unit/boundaries_test.ts` are unchanged.
  `git diff --check main...acdef43` passed.
- `deno task lint`: passed, 159 files. `deno task check`: passed. The focused test command additionally
  type-checks the new binding, which is not yet imported by the task's application entrypoints.
- `deno fmt --check` over the 12 owned files: passed, 12 files. Repo-wide `fmt:check` was not rerun; the three
  pre-existing failures listed in the brief are outside this review's scope.
- `deno test --v8-flags=--expose-gc -A tests/unit/sqlite_ffi_crud_test.ts
  tests/unit/sqlite_ffi_cancel_test.ts tests/unit/sqlite_ffi_perf_test.ts`:
  **20 passed, 0 failed** (13 CRUD, 6 cancellation, 1 performance; 5 seconds).
- Two further standalone runs of `sqlite_ffi_cancel_test.ts` with the same flags: **6 passed, 0 failed each**.
  The table records all three requested runs. Timing values are milliseconds; load columns are `uptime`'s
  1/5/15-minute load averages sampled before each invocation.

| Run | Load average       | Five deadline cancel latencies     | Median | Abort observed / reported | Four concurrent cancel latencies | closeAsync |
| --- | ------------------ | ---------------------------------- | ------ | ------------------------- | -------------------------------- | ---------- |
| 1   | 3.06 / 2.47 / 1.32 | 0.632, 0.582, 0.284, 0.166, 0.228  | 0.284  | 7.470 / 0.292             | 0.22, 0.24, 0.12, 0.16           | 0.385      |
| 2   | 3.06 / 2.52 / 1.37 | 0.720, 14.787, 1.432, 2.555, 0.233 | 1.432  | 2.788 / 0.172             | 5.40, 0.25, 0.38, 0.20           | 3.541      |
| 3   | 3.60 / 2.65 / 1.42 | 0.633, 0.322, 1.312, 0.222, 11.086 | 0.633  | 7.850 / 4.428             | 4.52, 3.10, 4.10, 0.25           | 2.080      |

- Deadline loop probes: run 1 had 68–76 ticks, maximum gap 10.5 ms, 49–55 point reads; run 2 had 34–55 ticks,
  maximum gap 24.0 ms, 25–39 point reads; run 3 had 54–61 ticks, maximum gap 22.7 ms, 37–43 point reads.
  Four-connection totals were 162.1 / 171.8 / 167.5 ms, loop ticks 60 / 47 / 48, maximum gaps 6.3 / 11.5 /
  10.9 ms. All printed gates passed.
- Point-read p50/p99 in microseconds: `node:sqlite` **8.751 / 43.683** (24,000 reads), FFI sync **8.528 /
  51.882** (24,000), FFI nonblocking **57.127 / 513.445** (2,000). Parity passed.
- `deno test --v8-flags=--expose-gc -A tests/unit/boundaries_test.ts`: **6 passed, 0 failed**.
  `rg -n 'Deno.dlopen' platform` found only `platform/sqlite_ffi/library.ts:109`.
- `deno task test:prop`: **79 passed, 0 failed** (5m56s; default seed 20261010).
- `deno task test`: **629 passed, 2 failed, 1 ignored** (7m29s; exit 1). Failures:
  `tests/unit/ipc_test.ts:663` (late reply while another caller waits) and
  `tests/unit/number_dialects_test.ts:243` (SQLite/DuckDB number boundary matrix; DuckDB child leg exited
  nonzero at `runLeg`'s exit-code assertion). Both files are unchanged by this item. Isolated reruns with the
  same flags and name filters passed: IPC **1 passed, 0 failed, 26 filtered out** (527 ms), number boundary
  matrix **2 passed, 0 failed** (7 seconds, including its reference-only check). The full suite was not rerun
  and is not claimed green. These non-reproducing failures are recorded separately from the three demonstrated
  binding defects; this review does not establish their root causes.

## Remaining review checklist

The sole nonblocking symbol takes only a SQLite-owned statement pointer. Synchronous out-parameter buffers are
not passed to it. Text and nonempty blob binds use `SQLITE_TRANSIENT`; empty blobs use zeroblob. Text reads
consume the full byte range when the C-string length differs, including embedded NUL and Unicode.
Column/name/error pointers are read before step/reset/finalize; blob results are copied. Int32 binds,
safe-integer double reads, bigint reads and unsafe-integer rejection match the stated contract.

Ordinary active-execution guards and the close waiter prevent freeing a handle during an already-running async
call, but defects 1 and 2 prevent an overall resource-safety pass. Defect 3 blocks CRUD correctness.
`interrupt()` itself is also unconditional while open (`database.ts:413`); it does not establish that a step
has entered SQLite. Accepted libraries remain loaded; only rejected, unused libraries are closed. Tests and
the benchmark keep `node:sqlite` and FFI databases in separate files. No FFI-03 gaps (autocommit state,
statement cache, Effect wrappers or core-error mapping) are counted as defects. The general plan's older
3.45/default-soname wording is superseded for this review by FFI-01's explicit as-built 3.37/path-list
contract.

Learning assessment: preserve the distinction between native step dispatch and actual entry, the need to guard
FFI lifetimes across JavaScript getters/reentrancy, and reset-time commit failures after a RETURNING row, in
docs/knowledge/ after fixes. This review does not edit that directory.
