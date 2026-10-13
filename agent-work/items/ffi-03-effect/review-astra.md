# FFI-03 independent review

Reviewer: Astra (`gpt-6-astra`), independent of builder Claude Opus 5.5 (`opus-ffi-03`)\
Actor: `astra-review-ffi-03`\
Date: 2026-10-13\
Reviewed SHA: `2cbc49d` (`item/ffi-03-effect`)\
Base: `item/ffi-binding` at `9250359` (FFI-01, reviewed PASS)\
Main baseline: `dedef4f`

Verdict: FAIL

## DEFECTS

1. **Caller-thrown tagged values enter the wrong Effect channel** — `platform/sqlite_ffi/effect.ts:66–67`
   (classification at `:56–59`, option-getter catch at `:192–194`, rejection handler at `:197`). The review
   contract requires caller-thrown values to become defects carrying the original value. `fromThrown` decides
   provenance solely by `instanceof`. A caller's parameter getter or `timeoutMs` getter can throw its own
   frozen `SqliteUsageError`; both sync and async wrappers then produce `Cause.Fail` with that object, not
   `Cause.Die`. Identity is preserved, but the channel is wrong. This can make a caller defect look like a
   recoverable binding failure to FFI-04/05's error mapping or retry logic. This is an error-channel contract
   defect, not a native lifetime regression.

   **Reproduced:** parameter-getter sync, parameter-getter async, and wrapper option-getter async all returned
   the identical object in `Cause.failureOption`, with `Cause.dieOption` empty. The connection was free
   afterwards. The option-getter catch explicitly identifies these exceptions as caller-origin (`:193`), yet
   applies the same class-based classification. The existing test only throws an ordinary `Error`, which
   cannot expose this distinction.

   **How to verify the repair:** run the following in `deno eval` from the repository, then cover the
   corresponding async call and a throwing `timeoutMs` getter. At this SHA the final assertion fails.

   ```ts
   import assert from "node:assert/strict";
   import { Cause, Effect, Exit, Option } from "effect";
   import { Database, get, SqliteUsageError } from "./platform/sqlite_ffi/mod.ts";

   const db = Database.open(":memory:");
   try {
     const thrown = Object.freeze(new SqliteUsageError({ reason: "busy", detail: "caller-owned" }));
     const params = {
       get x() {
         throw thrown;
       },
     };
     const exit = Effect.runSyncExit(get(db.prepare("SELECT :x"), params));
     assert.ok(Exit.isFailure(exit));
     const defect = Cause.dieOption(exit.cause);
     assert.ok(Option.isSome(defect) && defect.value === thrown);
   } finally {
     db.close();
   }
   ```

   Preserve caller origin across this boundary without annotating or mutating the thrown object; keep genuine
   binding failures typed and preserve arbitrary thrown values, including Proxies. A class test cannot
   establish origin. If exposing binding provenance requires changes beyond FFI-03's additive ownership,
   coordinate that scope with FFI-01; do not silently weaken the stated caller-defect contract.

## Notes and acceptance assessment

- **Effect.timeout deviation accepted; not a defect.** Inspected installed Effect **3.22.2** source at
  `node_modules/.deno/effect@3.22.2/node_modules/effect/src/internal/effect/circular.ts:510–543,603–650`.
  `timeout` calls `timeoutFail` with `timeoutExceptionFromDuration`; the timer-winning branch interrupts the
  loser through `interruptAsFiber` and substitutes `onTimeout()`. It does not propagate the loser's
  cancellation failure. The substitute test is adequate: it asserts `TimeoutException`, observes the actual
  binding promise rejecting `SqliteCancelled("aborted")`, checks `inFlight === false` immediately on return,
  and reuses the connection. Its separate `timeoutMs` case asserts the typed `SqliteCancelled("deadline")` and
  reuse. This does not mean an earlier inner failure cannot win the race.
- **Scope and interruption:** `openDatabase` uses `acquireRelease`, and release awaits `closeAsync`. Tests
  cover both a daemon execution cancelled by connection release and a scoped fiber cancelled before release.
  The async canceler aborts its private controller, catches abort exceptions, and awaits the same binding
  promise with both outcomes swallowed. It makes no direct connection/native call. Binding settlement follows
  reset and reservation release. All three focused runs meet the 50 ms scope-close and interrupt gates. An
  independent watchdog probe ran **100 early Effect interruptions**, checking an interrupted exit, a free
  connection and a successful point read after each.
- **Transactions:** the additive getter checks closed state first, refuses an active connection before native
  access, then reads `sqlite3_get_autocommit`. Tests cover BEGIN/COMMIT/ROLLBACK, closed state, in-flight
  busy, and SQLite's automatic rollback after an interrupted write. The writer's release at
  `platform/sqlite.ts:383–413` is compatible when migrated to these wrappers: success, failure and
  interruption all wait for release before the transaction finalizer reads `inTransaction`. Preserve that
  structured sequencing and the writer semaphore; detached executions on the writer would violate it.
- **Cache:** per-connection WeakMap, exact SQL-text keys, Map-order LRU and capacity 64. Successful misses
  precede insertion/eviction, so failed prepare cannot discard an existing entry; the base binding finalizes
  partially prepared native statements on failure. A busy miss fails before eviction; hits may reorder but do
  not finalize. One-shots are finalized on the next idle call. No await or caller code lies between successful
  native prepare and ordinary eviction for the documented string input. The tests observe at most 64 retained
  live statements over 501 issued objects and preserve the repeatedly touched hot entry. Evicted caller-held
  references fail typed `finalized`; README explicitly documents this lifetime, so it is acceptable. No
  lease/pinning guarantee should be assumed by consumers.
- **Schema changes:** SQLite's existing `prepare_v2` automatic reprepare and the binding's
  `SQLITE_STMTSTATUS_REPREPARE` column-name refresh remain intact. An independent probe reused the same cached
  `SELECT *` after ALTER, observed the added column, then dropped the table (typed failure), recreated it with
  different columns and successfully reused the same Statement. A further 100 invalid prepare attempts left
  the valid cached statement usable. No new schema or failed-prepare leak path was found by inspection; the
  probe is behavioral evidence, not a native allocation census.
- **Other thrown values:** independent sync/async probes preserved an opaque throwing Proxy, `undefined` and
  `42` in the defect channel by identity/value. `isSqliteFfiError` returned false without throwing on a Proxy
  whose `getPrototypeOf` trap throws. Ordinary binding errors remain typed. Defect 1 is the caller-owned
  tagged-value exception to this behavior.
- **FFI-01 invariants and ownership:** exactly the six allowed files changed (990 insertions, 3 deletions).
  `database.ts` adds only the 14-line getter; `library.ts` adds only the one synchronous native symbol. No
  base execution/cleanup logic changed. The sole nonblocking symbol still takes only the SQLite-owned
  statement pointer; no JS-owned buffer crosses it and no UnsafeCallback was added. `deno.json`, all existing
  FFI tests and all platform callers are untouched. `git diff --check` passes.
- **FFI-04/FFI-05:** migrate every SQLite user and live-file test inspector together; the two SQLite copies
  must not open the same file in one process. Use `timeoutMs` for the typed deadline mapping, preserve fiber
  interruption as interruption, and await wrapper completion before transaction cleanup. Prepare and execute
  cached statements close together; a returned statement may be finalized by a later cache miss, and a
  one-shot by the very next idle prepare. Bind parameters are an array or named object. Handle the five-tag
  union explicitly and resolve defect 1 before relying on its failure/defect distinction.

## Checks run

Environment: Deno 2.9.5, V8 15.0.245.2-rusty, TypeScript 6.0.3, Effect 3.22.2; loaded
`/usr/lib/x86_64-linux-gnu/libsqlite3.so.0`, SQLite 3.45.1. Commands used
`export PATH="$HOME/.deno/bin:$PATH"`. Product source was not edited.

- `deno task lint`: **passed, 161 files**, 1.327 s wall.
- `deno task check`: **passed**, 18.316 s wall.
- `deno fmt --check` on the six owned files: **passed**, 0.148 s wall.
- Focused command below: **47 passed, 0 failed, three times** (11 Effect, 18 CRUD, 11 cancellation, 1 binding
  performance, 6 boundaries).
- `deno task test`: **652 passed, 0 failed, 1 ignored**, runner 6m11s, wall 6m31.322s, exit 0. The ignored
  case is the opt-in real-S3 test. `ipc_test.ts` and `number_dialects_test.ts` passed in the full run; no
  isolated reruns were needed.
- `deno task test:prop`: **79 passed, 0 failed**, runner 5m0s, wall 5m12.159s, exit 0; default seed
  **20261010**.
- Independent inline probes: schema reprepare/recovery, failed prepares, opaque thrown values, the three
  tagged-value reproductions and 100 early Effect interruptions, as described above.
- Repo-wide `fmt:check` was not rerun; supplied pre-existing documentation formatting failures outside this
  item are excluded. The six changed files passed their explicit check.

```sh
deno test --v8-flags=--expose-gc -A \
  tests/unit/sqlite_ffi_effect_test.ts tests/unit/sqlite_ffi_crud_test.ts \
  tests/unit/sqlite_ffi_cancel_test.ts tests/unit/sqlite_ffi_perf_test.ts \
  tests/unit/boundaries_test.ts
```

Loads are `uptime` 1/5/15-minute samples immediately before each run; host uptime was 29 days, 14:24–14:25.
The first focused run overlapped lint/type checking; the full/property tasks began only after all three
focused runs completed. Times in the following table are milliseconds except the explicit seconds column.

| Run | Load               | Runner / wall seconds | Scope close daemon / scoped | Fiber interrupt | Effect timeout 30 / binding deadline 30 |
| --- | ------------------ | --------------------- | --------------------------- | --------------- | --------------------------------------- |
| 1   | 1.07 / 1.40 / 1.55 | 20 / 28.723           | 14.992 / 30.304             | 1.515           | 39.916 / 34.312                         |
| 2   | 2.79 / 1.78 / 1.67 | 14 / 15.905           | 10.396 / 6.923              | 2.106           | 44.411 / 32.919                         |
| 3   | 2.46 / 1.76 / 1.66 | 14 / 15.687           | 10.479 / 7.768              | 2.177           | 38.159 / 32.212                         |

Cached point-read parity uses **two separate files**, one per SQLite library, with 24,000 reads per measured
path and alternating round order. The FFI path includes `prepareCached` lookup and LRU reordering; node's
baseline reuses prepared statements. All three ratios pass the 1.3 gate.

| Run | node reused p50 / p99 µs | FFI cached p50 / p99 µs | p50 ratio | node prepare per call p50 µs |
| --- | ------------------------ | ----------------------- | --------- | ---------------------------- |
| 1   | 8.407 / 39.229           | 8.820 / 42.157          | 1.049     | 32.494                       |
| 2   | 8.214 / 43.111           | 8.552 / 45.985          | 1.041     | 32.126                       |
| 3   | 8.351 / 38.941           | 8.997 / 44.664          | 1.077     | 31.333                       |

FFI-01 cancellation regression checks also passed: five-run deadline medians 0.243 / 0.306 / 0.310 ms;
immediate-abort maxima 7.954 / 6.028 / 10.865 ms; all 16 simultaneously aborted connections settled in 2.420 /
1.969 / 5.602 ms. These do not establish blocking-pool saturation at production concurrency.

Full and property suites ran concurrently, starting at 14:07:10 UTC with load **1.83 / 1.69 / 1.64** and host
uptime 29 days, 14:26. Samples during overlap were **3.69 / 2.24 / 1.83** and **5.27 / 3.31 / 2.29**; a later
full-suite sample was **3.25 / 3.25 / 2.46**, uptime 29 days, 14:32. These are observations, not peak-load
claims. The Effect performance test also passed inside the full suite: cached FFI p50 **8.889 µs** versus
reused node p50 **7.879 µs**, ratio **1.128**.

Learning assessment: waiting for binding settlement makes cancellation safe for transaction cleanup, but error
class alone does not distinguish a binding failure from a caller-thrown value of the same class.
