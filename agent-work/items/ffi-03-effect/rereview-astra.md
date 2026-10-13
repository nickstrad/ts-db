# FFI-03 independent repair re-review

Reviewer: Astra (`gpt-6-astra`), fresh independent reviewer of the Opus repair\
Actor: `astra-rereview-ffi-03`\
Date: 2026-10-13\
Reviewed SHA: `daeb6376633b65b70773a0d09df6a53ea325e5d9`\
Delta from: `2cbc49d`\
Base: `item/ffi-binding` at `9250359`\
Main baseline: `dedef4f`

Verdict: PASS

## DEFECTS

None (0). Original defect 1 is resolved.

## NITS / notes and rulings

No NITS.

1. **Original defect 1 is repaired.** Independently ran the FAIL report's inline probe, extended with async
   parameter and async `timeoutMs` getters. All three return `Cause.Die` containing the identical frozen
   caller-owned `SqliteUsageError`, with no `Cause.Fail`, unchanged own-property descriptors, an idle
   connection, and successful subsequent sync and async reads. The new regression test also covers an
   extensible tagged error, spans, an opaque throwing Proxy, parameter-container traps, and open options.
   Nothing annotates, unwraps, or classifies the snapshot's thrown value by its class.

2. **The provenance boundary is sound for the supported contract and the identified adversarial inputs.**
   `effect.ts:103` separates snapshot exceptions from binding exceptions. Array elements and named getters are
   evaluated into private copies; named copies have no prototype. Views are re-wrapped through intrinsic
   getters, bypassing shadowed `buffer`, `byteOffset`, and `byteLength`. Ordinary unsupported objects and
   Proxy values reach `database.ts:950` without coercion: rejection uses `typeof` and `ArrayBuffer.isView`,
   not `toString`, `valueOf`, or `Symbol.toPrimitive`. Independent probes with throwing getters for all three
   coercion hooks remained typed `SqliteValueError` without invoking the getters. Option-object rendering does
   run coercion, but in phase 1; throwing `Symbol.toPrimitive` on both timeout options preserved defect
   identity. Boolean open options use truthiness/strict equality, which invoke no object conversion.

   The wrapper creates its own controller and passes own `signal` and `timeoutMs` properties. It never reads a
   caller's extra `signal` property (verified with a throwing getter). The binding therefore installs and
   removes listeners on a native signal inaccessible to the caller. Private-field receiver checks invoke no
   receiver traps. The `parameterCount` getter returns its private count even after close/finalize, so the
   snapshot does not intercept a binding-origin `closed`/`finalized` error and turn it into a defect. Those,
   bind-count/name/type errors, SQL errors, and deadlines remain typed. No remaining caller-origin tagged
   value entering the typed channel was found. Patching built-ins, binding prototypes, or native dispatch
   changes the binding and is outside this claim.

3. **Prototype dispatch: justified hardening, with a documented compatibility cost.** Calling methods and
   accessors through the binding's prototypes prevents a shadowed instance method from injecting caller code
   into phase 2. Cache dispatch uses the same rule. This bypasses legitimate instance-level spies as well as
   hostile shadows, but the README expressly documents it and tests restore their prototype spies with
   `using`. This is acceptable for the unreleased FFI-04/05 integration surface. Instrument the surrounding
   Effect in production; do not assume instance wrapping will intercept these calls. Prototype patching is
   global and is not protected by this provenance contract.

4. **Pinning `Statement.sql`: justified, not gratuitous over-hardening.** `admit` first brand-checks the
   receiver, rejects an accessor without invoking it, then makes the data property non-writable and
   non-configurable. A one-time read alone would not prevent an accessor from being installed between async
   steps. The binding reads `this.sql` when constructing errors after those steps. Its only assignment to
   `sql` is in the constructor (`database.ts:609`); finalize, reset, and automatic reprepare do not rewrite
   it. The mutation therefore enforces the existing readonly type without breaking the binding's lifecycle.
   The README documents the mutation and accessor rejection. An independent multi-turn deadline probe
   confirmed both descriptor flags, rejection of attempted accessor installation during execution, typed
   cancellation, and reuse. It is an intentional observable descriptor change, not a promise of transparent
   compatibility with callers rewriting readonly metadata.

5. **`closeAsync` still calls `this.close()`: acceptable outside-contract limitation, not a defect or NIT.**
   Confirmed at `database.ts:559`. Calling the prototype's `closeAsync` bypasses an instance shadow of that
   method, but does not make its internal dispatch immune to a shadowed `close`. Such a caller can prevent
   release. This was already possible before the repair and requires replacing resource lifecycle methods,
   outside the caller contract specified for this review. No ordinary release regressed. The README's
   direct-dispatch description must not be read as a guarantee that every internal binding call ignores
   instance methods. FFI-04/05 must leave `close` intact; broadening tamper resistance here would require a
   binding change, not more wrapper machinery.

6. **Snapshot timing changes: acceptable and documented.** All reachable parameter getters now run before
   reserving the connection, including getters after an earlier invalid value. A getter can successfully
   close/finalize before the binding starts; the following call then fails typed `closed`/`finalized`.
   Wrong-length positional lists retain the binding's early count rejection without reading elements. This
   changes error precedence for side-effecting getters, deliberately establishing provenance before native
   execution. The inspected `platform/sqlite.ts` and `platform/document_reader.ts` call sites use compiled SQL
   and plain value arrays, so the migration has no such getter dependency. Path, SQL, and library path must be
   strings; invalid non-string inputs are TypeError defects as documented.

7. **The `Effect.die` finding is confirmed and belongs in FFI-05's span work.** Installed Effect 3.22.2's
   `src/internal/core.ts:690–693` tests `spanSymbol in defect`; `capture` at lines 668–685 constructs a Proxy
   when a current span exists. Independent runtime probes observed the `has` trap and a different defect
   identity under `withSpan`. `Effect.failCause(Cause.die(value))` directly stores the original value and
   avoids both operations. Keep this path for opaque caller defects; replacing it with `Effect.die` is not
   equivalent. `Effect.fail` also captures span metadata, so binding failures may be span proxies; their typed
   classification is preserved, whereas exact opaque caller-defect identity is the stronger contract repaired
   here. Logging/pretty-printing an arbitrary defect can itself inspect it; tests correctly avoid doing so on
   their successful assertion path.

8. **Prior review rulings stand.** `Effect.timeout` produces Effect's `TimeoutException`; fiber interruption
   remains interruption while the underlying binding observes `SqliteCancelled("aborted")`. Use wrapper
   `timeoutMs` for typed deadline mapping. The canceler still awaits binding settlement, so transaction
   cleanup can inspect the idle connection. Preserve the writer semaphore and structured finalization; keep
   writes synchronous where an interrupted fiber must not hide an already committed async write. Cached
   statements retain the documented eviction/one-shot lifetimes. FFI-04 must switch all same-file SQLite users
   together, and FFI-05 must explicitly map the five binding tags without converting defects into recoverable
   failures.

9. **Ownership verified.** `git diff --stat 2cbc49d..daeb637` contains only `platform/sqlite_ffi/effect.ts`,
   `platform/sqlite_ffi/README.md`, and `tests/unit/sqlite_ffi_effect_test.ts`: 590 insertions, 69 deletions.
   The binding files, `deno.json`, and platform consumers are untouched by the repair. `git diff --check`
   passes. This session edited no product source; its authored files are this report and the shared event-log
   entries.

## Checks

Environment: Deno 2.9.5, V8 15.0.245.2-rusty, TypeScript 6.0.3, Effect 3.22.2. All Deno commands used
`export PATH="$HOME/.deno/bin:$PATH"`.

- `deno task lint`: passed, 161 files.
- `deno task check`: passed.
- `deno fmt --check platform/sqlite_ffi/effect.ts platform/sqlite_ffi/README.md
  tests/unit/sqlite_ffi_effect_test.ts`:
  passed, 3 files.
- Focused command below: **50 passed, 0 failed, three times** (14 Effect, 18 CRUD, 11 cancellation, 1 binding
  performance, 6 boundaries); runner durations 14 / 13 / 14 seconds.
- `deno task test`: **655 passed, 0 failed, 1 ignored**, runner 5m36s, wall 5m56.850s. The ignored case is the
  opt-in real-S3 test. Neither `ipc_test.ts` nor `number_dialects_test.ts` failed; no isolated reruns were
  needed.
- `deno task test:prop`: **79 passed, 0 failed**, runner 3m58s, wall 4m9.283s; seed **20261010**.
- Independent inline probes: original failure's three cases; coercion and private-signal checks; multi-turn
  SQL pinning; Effect.die inspection/span identity, all passed.
- Repo-wide `fmt:check` was not rerun: the supplied two-document failure on main is outside this item.

```sh
deno test --v8-flags=--expose-gc -A \
  tests/unit/sqlite_ffi_effect_test.ts tests/unit/sqlite_ffi_crud_test.ts \
  tests/unit/sqlite_ffi_cancel_test.ts tests/unit/sqlite_ffi_perf_test.ts \
  tests/unit/boundaries_test.ts
```

The focused runs began at 14:33:22 / 14:33:43 / 14:33:57 UTC, host uptime 29 days, 14:52. Load columns below
are `uptime`'s 1/5/15-minute samples immediately before each run. Run 1 overlapped lint/type checking. The
full/property tasks began after the focused runs completed.

| Run | Load               | Node reused p50 µs | FFI cached p50 µs | Ratio | Node prepare-per-call p50 µs |
| --- | ------------------ | ------------------ | ----------------- | ----- | ---------------------------- |
| 1   | 0.70 / 1.34 / 1.83 | 8.346              | 8.826             | 1.057 | 31.822                       |
| 2   | 1.25 / 1.43 / 1.85 | 7.676              | 8.452             | 1.101 | 30.045                       |
| 3   | 2.70 / 1.72 / 1.94 | 8.992              | 9.698             | 1.079 | 37.020                       |

All pass the strict 1.3 cache-path gate. As in the original review, the benchmark measures
`prepareCached(db, sql).get(params)` against a reused node statement, with 24,000 samples per path,
alternating rounds and separate files for the two SQLite libraries. It includes cache lookup/reordering; it
does **not** measure `Effect.runSync(get(...))` or isolate the new snapshot's overhead. These numbers must not
be presented as end-to-end Effect or instrumented platform latency.

| Run | Scope close daemon / scoped ms | Fiber interrupt ms | Effect timeout / binding deadline ms |
| --- | ------------------------------ | ------------------ | ------------------------------------ |
| 1   | 17.076 / 8.290                 | 1.743              | 37.905 / 31.732                      |
| 2   | 9.833 / 7.136                  | 2.097              | 38.315 / 33.548                      |
| 3   | 8.338 / 7.042                  | 1.943              | 38.626 / 32.084                      |

The timeout inputs were 30 ms; all scope-close checks pass the 50 ms gate. Binding-only performance tests also
passed: sync p50 7.817 / 8.032 / 8.101 µs versus node 7.814 / 7.574 / 7.809 µs; nonblocking p50 48.691 /
46.856 / 68.043 µs. Five-run cancellation medians were 0.317 / 0.227 / 0.299 ms.

Full/property suites started at 14:34:28/29 UTC, uptime 29 days, 14:53, with loads 1.87 / 1.62 / 1.90 and 2.12
/ 1.68 / 1.91 respectively. They ran concurrently. A 14:35:33 sample was 3.13 / 2.08 / 2.04. A later overlap
sample at 14:38:20 was 4.14 / 3.08 / 2.44 (uptime 29 days, 14:57). The property suite finished at 14:38:39
with load 3.90 / 3.08 / 2.45; the full suite finished at 14:40:25 with load 1.54 / 2.46 / 2.29 (uptime 29
days, 14:59). These are samples, not peak-load claims. The full suite also passed its cache performance gate:
FFI p50 9.034 µs versus node 7.973 µs, ratio **1.133**, with benchmark load 2.379 / 2.785 / 2.381.

Learning assessment: provenance requires a boundary that runs no caller code, and preserving an opaque
defect's identity also requires bypassing Effect's otherwise useful span-capture inspection.
