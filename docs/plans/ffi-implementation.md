# Plan: FFI execution layer — Deno FFI to the system `libsqlite3` on the statement path

Status: approved direction (nickstrad, 2026-10-13), plan proposed · Author: Fable 5.1 (with nickstrad) · Date:
2026-10-13 · Target branch: `item/ffi-NN-slug` branches off `main`, one commit per item · Baseline: `main` at
`dedef4f` (the `platform/`, `core/`, `sdk/` and `tests/` trees are identical to `e808983`, the commit the
research measured).

Turns the recommendation of [lang-switch-fable.md §8](../architecture/lang-switch-fable.md) into build items.
The design it implements is drawn in [docs/plans/ffi/](ffi/README.md) (C4 set) and restated in
[architecture-ste100.md](ffi/architecture-ste100.md). This plan builds the **execution layer only**: the FFI
binding, the connection and statement API over it, the cutover of the statement path away from `node:sqlite`,
and deadline-bounded execution for statements that can run long. It does not build lanes or placement (§6).

The first item is the FFI binding module itself. It is **built**: Claude Opus 5.5 (`claude-ffi-binding`)
pushed `item/ffi-binding` at `acdef43` on 2026-10-13 (`agent-work/items/ffi-binding/brief.md`); FFI-01 below
describes that slice as built so its review can be judged against this plan, and FFI-03 onward build on its
surface.

**Model pairs.** Every item names its pair under the repo's standing tier mapping (AGENTS.md "Model duality"):
**Opus 5.5 / Astra** (`opus`, `gpt-6-astra`) for items that decide semantics expensive to get wrong; **Sonnet
/ Sol** (`sonnet`, `gpt-6.1-sol`) for bounded work whose interfaces an earlier item fixed; **Haiku 5.5 / Luna
(high)** (`claude-haiku-5-5`, `gpt-6-luna` at high effort) for fast, tightly scoped work with
command-checkable acceptance. Either family within a tier is acceptable; the independent review is always
top-tier and by a different reviewer than the builder (Astra reviews an Opus build and vice versa). A
Haiku/Luna item lands only after an Opus/Astra PASS **and** explicit human approval (AGENTS.md; precedent
SP-08, Luna build). Every unit of work is a freshly spawned agent in its own worktree with its own event actor
(AGENTS.md "Fresh-agent lifecycle").

## 0. Where the code is today

Verified by reading `main` at `dedef4f` on 2026-10-13. Every SQLite call in the platform goes through
`node:sqlite`'s `DatabaseSync`, synchronously, on the event loop.

| Surface                                                                          | Today                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/sqlite.ts` (`Storage`, item 15)                                        | Opens the writer `DatabaseSync` under `acquireRelease`; `PRAGMA journal_mode=WAL; synchronous=FULL; busy_timeout=5000`; `Semaphore(1)` writer queue capped at `WRITER_QUEUE_CAP = 1000`; `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK` as `acquireUseRelease`; `database.prepare(sql.text)` per statement; `VACUUM INTO ?` for snapshots             |
| `platform/document_reader.ts` (SP-02)                                            | One read-only `DatabaseSync` per handler call, `BEGIN TRANSACTION` … `COMMIT`; `statement.setReadBigInts(true)`; `DOCUMENT_READ_CONCURRENCY_CAP = 32` permits; the 1000-pending admission cap; `Effect.timeoutFail` at `reader.callTimeoutMs` — the timeout fires but **cannot stop the statement**                                            |
| `platform/tenants/routing.ts` (MT-04)                                            | `StorageLocation.open: () => DatabaseSync`, re-checks containment and symlinks in the same synchronous step as the open; `prepare(location)` runs the DDL transaction on a short-lived `DatabaseSync`                                                                                                                                          |
| `platform/backup.ts` (item 19)                                                   | `verifySnapshot` opens the snapshot copy read-only with `DatabaseSync` and runs `PRAGMA quick_check`                                                                                                                                                                                                                                           |
| `platform/ipc.ts`, `platform/reader.ts`, `reader_layers`                         | The DuckDB reader child, JSON-lines IPC, supervised restart (fix/reader-supervision). The reader never imports `node:sqlite` (`tests/unit/boundaries_test.ts`)                                                                                                                                                                                 |
| `core/errors.ts`, `platform/http/router.ts`                                      | Closed error taxonomy (`Data.TaggedError`), `toHttpStatus`, `errors_exhaustiveness.ts`; a reader-call timeout is `IpcError{reason:"timeout"}` → 502                                                                                                                                                                                            |
| `core/events.ts`, `platform/eventlog/tables.ts`                                  | `SqlPayload{engine, statementKind, durationMs, outcome, …}` in JSONL; the DuckDB `sql_events` projection                                                                                                                                                                                                                                       |
| `tests/` (15 files)                                                              | Open files directly with `new DatabaseSync(...)` as an oracle or to inspect state; `tests/layers/storage_test_layer.ts` is the in-memory `Storage` double                                                                                                                                                                                      |
| Deno 2.9.5; `libsqlite3.so.0`                                                    | `Deno.dlopen` and `nonblocking` symbols run with no unstable flag (PoC). vm-1 has **two** `libsqlite3.so.0`: `/usr/local/lib` (3.53.4, first in the loader path) and `/lib/x86_64-linux-gnu` (3.45.1, the one the PoC loaded)                                                                                                                  |
| `platform/sqlite_ffi/` (FFI-01, `item/ffi-binding` @ `acdef43`, unlanded)        | `Database`/`Statement` over `Deno.dlopen(libsqlite3)`: sync `run/get/all`, async `runAsync/getAsync/allAsync` with `timeoutMs`/`AbortSignal` enforced by `sqlite3_interrupt`, `closeAsync`, tagged errors (`SqliteError`, `SqliteCancelled`, `SqliteUsageError`, `SqliteValueError`, `SqliteLibraryError`); ≥ 3.37.0 gate; nothing uses it yet |
| `work-scripts/deno/ffi-sqlite-*.ts`, `lane-kill-latency`, `ffi-binding-bench.ts` | The PoC harnesses on `research/fable-lang-switch` and FFI-01's bench (items reuse them: §4)                                                                                                                                                                                                                                                    |

There are no lanes on `main`. The only child process is the DuckDB reader. The process boundary this plan
works inside is the API process. `deno task fmt:check` is red on `main` at `dedef4f` from three docs files
outside this plan (`README.md`, `docs/knowledge/decisions.md`, `docs/architecture/README.md`); until a docs
fixup lands, "`deno task ci` green" in the gates below means green with those three pre-existing fmt failures
excepted, and FFI-02, which owns `README.md`, formats it.

## 1. Target

### 1.1 What changes

```text
today                                        after FFI-05
HTTP → handler → DatabaseSync.prepare().all()   HTTP → handler → classifier
                 (sync, event loop,                 ├─ bounded plan ──► blocking sqlite3_step, lane/API main thread (6–7 µs)
                  cannot be interrupted)            └─ unbounded plan ► nonblocking sqlite3_step on a pool thread, deadline,
                                                                        sqlite3_interrupt from the main thread (≈0.4 ms)
                 node:sqlite (rusqlite 0.40,        platform/sqlite_ffi/ → Deno.dlopen(libsqlite3.so.0)
                 bundled in the Deno binary)
```

1. **One binding, two step paths.** `platform/sqlite_ffi/` loads the system `libsqlite3` with `Deno.dlopen`
   and exposes the SQLite C API the platform needs, with `sqlite3_step` declared twice: once blocking, once
   `nonblocking: true` (runs on Deno's blocking thread pool, returns a `Promise`).
2. **A classifier decides the path once per statement** (FFI-05). Bounded plan = primary-key equality select
   (`filters` contain `{field:"_id", op:"eq"}`), `insert`, `patch`, `delete`, and the writer's own reads
   inside a `patch`. Everything else — any other `select`, `count`, `countBy` — is unbounded and runs
   nonblocking under a deadline. This is the §3.2 rule of the study: the nonblocking path costs 35 to 60 µs
   and a p99 tail up to 2 ms, so only statements that can run long pay it.
3. **Deadlines are enforced by `sqlite3_interrupt`**, not by a timeout that gives up waiting. The call that
   today fails with `IpcError{timeout}` while the statement keeps running will fail with a typed
   `StatementDeadlineError` **and the statement stops** (measured 0.41 ms, outliers to 8.8 ms).
4. **`node:sqlite` leaves `platform/`.** After FFI-04 no file under `platform/` imports it; the boundary test
   enforces this the way it enforces the DuckDB/SQLite split today.

### 1.2 The one rule that orders the items

**Never open the same database file through two copies of SQLite in one process.** `node:sqlite` is rusqlite's
bundled SQLite inside the Deno binary; the FFI binding is the system `libsqlite3`. Each copy tracks POSIX
advisory locks per inode inside its own process-wide table, and POSIX drops every lock a process holds on a
file when _any_ descriptor to that file is closed. Two copies in one process do not know about each other's
descriptors, so a reader closing through one copy can silently release the writer's lock held through the
other. This is the same reason the reader child never loads `node:sqlite` beside DuckDB's SQLite extension
(main plan §0, "the hard architectural constraint"), applied inside the API process.

Consequences:

- The writer (`Storage`), the document reader, the router's `prepare` and the backup verifier switch together,
  in one SYNC item (FFI-04), exactly as SP-02 moved the read path in one item. There is no per-file or
  per-path driver flag.
- Tests that open a live file with `DatabaseSync` while the server holds it open through the binding must
  switch to a binding-based inspection helper in the same commit (FFI-04 owns them).
- Until FFI-04 lands, the binding is exercised only against files nothing else has open (its own temp files),
  which is what FFI-01 and FFI-03's tests do.
- Rollback is `git revert` of the FFI-04 commit. No flag, no dual-driver period — the human's SP-02 ruling
  ("no flag, direct swap") applies here for a stronger reason.

### 1.3 Threading model inside the binding

- Connections open with `SQLITE_OPEN_FULLMUTEX` (serialized mode) so a `sqlite3_interrupt` from the main
  thread while a pool thread is inside `sqlite3_step` is defined behaviour; SQLite documents `interrupt` as
  safe to call from another thread. The binding checks `sqlite3_threadsafe() != 0` at load.
- **One execution in flight per connection.** The writer already guarantees this (`Semaphore(1)`); the
  document reader opens one connection per call. The binding enforces it anyway: while an async execution is
  in flight every other call on that connection fails `SqliteUsageError("busy")`, never a wait on SQLite's
  mutex from the event loop (FFI-01 design decision 1).
- A nonblocking step holds only SQLite-owned pointers (`sqlite3_stmt*`). Nothing JS-owned is passed to a
  nonblocking call, so there is no buffer for the GC to move or collect under the C call.
- No `UnsafeCallback` anywhere: busy handling is `sqlite3_busy_timeout`, cancellation is `interrupt`, and
  there is no progress handler or trace callback. Callbacks invoked from foreign threads are the one Deno FFI
  feature with documented footguns, and the design does not need them.
- `finalize` and `close` refuse (`"busy"`) while an async execution is in flight; `closeAsync` cancels it,
  waits for the pool thread to leave `sqlite3_step`, then closes. FFI-03's scope finalizer uses `closeAsync`;
  it is the resource rule of item 15 extended by one case. The loaded library is never `dlclose`d.

## 2. Deno-FFI specifics the builders must respect

Facts established by the PoC on Deno 2.9.5 (`work-scripts/deno/ffi-sqlite-interrupt.ts`,
`ffi-sqlite-read-cost.ts`; raw JSON under `docs/architecture/lang-switch-fable-data/`), plus the points FFI-01
must verify rather than assume:

| Topic               | What is known / what to do                                                                                                                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission          | `--allow-ffi` (path-scoped to the library is preferred: `--allow-ffi=<path>`). Every task already runs with `-A`; `deno.json` stays frozen.                                                                                                                                                                                                         |
| Stability           | `Deno.dlopen`, `nonblocking`, `UnsafePointer`, `UnsafePointerView` ran with no unstable flag on 2.9.5. Pin the Deno version the repo already pins; a Deno upgrade re-runs FFI-01's acceptance.                                                                                                                                                      |
| Library resolution  | `Deno.dlopen("libsqlite3.so.0")` goes through the loader search path, which on vm-1 picks 3.53.4 under `/usr/local/lib`; the PoC loaded 3.45.1 explicitly. The binding takes an explicit path from config (FFI-02), defaults to the soname, logs the resolved `sqlite3_libversion()` once as a `lifecycle` event, and refuses anything below 3.45.0 |
| Pointers            | `sqlite3*` and `sqlite3_stmt*` come back through out-parameters: pass a `BigUint64Array(1)` as `"buffer"`, then `Deno.UnsafePointer.create(view[0])`. Pointers are opaque values; never arithmetic                                                                                                                                                  |
| Text in             | Bind with `sqlite3_bind_text(stmt, i, buf, byteLength, SQLITE_TRANSIENT)` using the explicit byte length from `TextEncoder`, never a NUL-terminated guess; `SQLITE_TRANSIENT` (`-1` as the destructor pointer) makes SQLite copy, so the JS buffer may be collected after the call                                                                  |
| Text out            | `sqlite3_column_bytes` then copy that many bytes from `sqlite3_column_text` (`UnsafePointerView.copyInto`) and decode UTF-8 — _not_ `getCString`, which stops at a NUL. This makes reads lossless where `node:sqlite` truncates (ADR 0005); the contract itself does not change in this plan (§6)                                                   |
| 64-bit integers     | `i64` results and arguments cross as `bigint` or `number` depending on Deno's representation rules. FFI-01 normalises: `column_int64` returns `bigint`; callers that need `number` convert and range-check. `tests/unit/number_dialects_test.ts` and `tests/property/json_number_test.ts` are the oracle for what the platform must observe         |
| Nonblocking cost    | 44 to 69 µs p50, p99 0.24 to 2.2 ms (thread hop + promise). Use it only on the unbounded path                                                                                                                                                                                                                                                       |
| Blocking cost       | 6.3 to 6.8 µs p50 per point read with a reused prepared statement vs 8.7 to 8.9 µs for `node:sqlite`; today's code prepares per call, so FFI-03 adds a bounded per-connection statement cache to keep that number                                                                                                                                   |
| Interrupt           | 0.41 ms typical, 0.34 to 8.8 ms across runs; `sqlite3_step` returns `SQLITE_INTERRUPT` (9). After an interrupt the statement must be `reset`; an interrupted write transaction is rolled back by SQLite — the `acquireUseRelease` release half already handles "COMMIT did not run"                                                                 |
| Pool size           | Deno documents nonblocking calls as running on a dedicated blocking thread; the pool's size and back-pressure under hundreds of concurrent long statements were not measured (study §9). The 32-permit document-read cap bounds concurrency in this plan; FFI-06 measures at the cap                                                                |
| Crash isolation     | A bug in the binding (bad pointer, double finalize) is a native crash of the API process, not a typed error. Lanes would isolate it (§6); in this plan the mitigations are `UnsafePointer` hygiene reviewed by Opus/Astra, the one-statement-per-connection rule, and the property tests of FFI-07                                                  |
| Two SQLite copies   | `node:sqlite` must never open a file the binding has open in the same process (§1.2). The boundary test forbids `node:sqlite` under `platform/`; tests use the binding's inspection helper                                                                                                                                                          |
| `deno check` / lint | FFI symbol tables are plain object literals; `deno check` covers them through `platform/server.ts`. `deno lint`'s `no-explicit-any` applies: type the symbol table with `as const satisfies Deno.ForeignLibraryInterface`                                                                                                                           |

## 3. Batch table and build order

| Batch | Items          | Scope                                                                  | Gate                                                                     |
| ----- | -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| FFI-A | FFI-01, FFI-02 | FFI binding module; config options and library resolution              | concurrent (disjoint files). FFI-01 **built** (`acdef43`), in review     |
| FFI-B | FFI-03         | Connection and statement API over the binding (scoped, two step paths) | after FFI-01; **SYNC** — its interface is what FFI-04 and FFI-05 consume |
| FFI-C | FFI-04         | Cutover: `Storage`, document reader, router, backup, tests             | after FFI-02 and FFI-03; **SYNC**, alone (the §1.2 rule)                 |
| FFI-D | FFI-05         | Classifier and deadline-bounded execution; `StatementDeadlineError`    | after FFI-04; **SYNC** (changes the error taxonomy)                      |
| FFI-E | FFI-06, FFI-07 | Perf harnesses and integration evidence; property tests                | concurrent, after FFI-05                                                 |
| FFI-F | FFI-08         | Docs, C4 diagrams, ADR, knowledge                                      | after FFI-06 and FFI-07; docs-only                                       |

Build order: `FFI-01 ∥ FFI-02 → FFI-03 → FFI-04 → FFI-05 → (FFI-06 ∥ FFI-07) → FFI-08`.

**Model policy** (AGENTS.md "Model assignment policy" and "Model duality"), applied per item below:

| Tier                | Pair                                                           | Items                          | Why                                                                                                                            |
| ------------------- | -------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Top                 | **Opus 5.5 / Astra** (`opus`, `gpt-6-astra`)                   | FFI-01, FFI-03, FFI-04, FFI-05 | Resource lifetimes, the two-SQLite-copies cutover, the error taxonomy, which statements may be interrupted                     |
| Middle              | **Sonnet / Sol** (`sonnet`, `gpt-6.1-sol`)                     | FFI-06, FFI-07                 | Interfaces fixed by earlier items; harness ports, property generators, thresholds checkable by a command                       |
| Fast, scoped        | **Haiku 5.5 / Luna (high)** (`claude-haiku-5-5`, `gpt-6-luna`) | FFI-02, FFI-08                 | Additive config rows with an exact pattern to copy; docs-only follow-up. Opus/Astra PASS **and** human approval before landing |
| Review (every item) | **Opus 5.5 / Astra**, a different reviewer than the builder    | all                            | Independent top-tier review is the standing rule; FFI-01 (built by Opus) is reviewed by Astra                                  |

Builders log `task_started`/`task_completed` through `work-scripts/bash/log-event.sh` with the item id in the
summary and a fresh actor per unit (`<model>-ffi-NN`); reviewers log `review_verdict` naming the reviewed SHA
and commit their report under `agent-work/items/<item>/`.

**Worktrees:** FFI-01 is `item/ffi-binding` in `/root/Software/tsdb-work/ffi-binding` (as built); FFI-02 …
FFI-08 use `/root/Software/tsdb-work/ffi02` … `ffi08`, branches `item/ffi-02-config` … `item/ffi-08-docs`.
Each review and each fixup gets its own worktree too. Nobody edits another unit's worktree.

## 4. Items

#### FFI-01 — The FFI binding module (built: `item/ffi-binding` @ `acdef43`)

- **Scoping:** CONCURRENT with FFI-02. **Built** on 2026-10-13 by Claude Opus 5.5 (`claude-ffi-binding`), from
  the PoC code and the study's §8 step 1; two commits (`5f998a8` the binding, `acdef43` the brief and claims).
  Awaiting its independent review.
- **Model:** **Opus 5.5 / Astra** — built by Opus 5.5, so the review goes to **Astra** (`gpt-6-astra`).
- **Branch / worktree:** `item/ffi-binding` · `/root/Software/tsdb-work/ffi-binding` (the builder's, as
  recorded in `agent-work/items/ffi-binding/claims.md`).
- **Owns (as claimed):** `platform/sqlite_ffi/mod.ts`, `library.ts`, `database.ts`, `errors.ts`;
  `tests/unit/sqlite_ffi_crud_test.ts`, `sqlite_ffi_cancel_test.ts`, `sqlite_ffi_perf_test.ts`;
  `work-scripts/deno/ffi-binding-bench.ts`; `work-scripts/INDEX.md` (one row); `docs/knowledge/gotchas.md`
  (two entries); `agent-work/items/ffi-binding/brief.md`, `claims.md`.
- **Reads:** `core/errors.ts`, `platform/sqlite.ts`, `tests/unit/boundaries_test.ts`; the PoC scripts and the
  study on `research/fable-lang-switch`; `docs/plans/ffi/README.md`.
- **What it delivers** (the surface FFI-03 … FFI-05 build on):
  1. `library.ts`: one symbol table (`as const satisfies Deno.ForeignLibraryInterface`) with `sqlite3_step`
     bound twice, blocking and `nonblocking`; `loadLibrary(path?)` tries `DEFAULT_LIBRARY_PATHS` in order,
     checks `sqlite3_threadsafe()` and `libversion_number ≥ 3.37.0`, caches per path and never `dlclose`s.
  2. `database.ts`: `Database.open(path, { readOnly, create, uri, busyTimeoutMs, readBigInts, libraryPath })`
     with `SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_EXRESCODE`; `exec`; `prepare` (exactly one statement);
     `Statement.run/get/all` (sync, main thread) and
     `runAsync/getAsync/allAsync(params, { timeoutMs, signal })` (pool thread, `sqlite3_interrupt` from the
     main thread, rejects `SqliteCancelled`); `close` / `closeAsync`; `interrupt()`. Positional and named
     binds; `null | number | bigint | boolean | string | ArrayBufferView`; text with embedded U+0000
     preserved; INTEGER as `number`, `bigint` under `readBigInts`, `SqliteValueError` past ±(2^53−1)
     otherwise.
  3. `errors.ts`: binding-local `Data.TaggedError`s with structured fields —
     `SqliteError{code, extendedCode}`, `SqliteCancelled{reason}`,
     `SqliteUsageError{reason: "busy" | "closed" | "finalized" | …}`, `SqliteValueError`,
     `SqliteLibraryError`. Joining them to `PlatformError` is FFI-04/05's work.
  4. Rules enforced: one execution per connection (`"busy"`), executions run to completion and reset, explicit
     lifetimes (use after close/finalize is typed), no `UnsafeCallback`, no `FinalizationRegistry`.
- **Acceptance evidence** (from the brief; the reviewer verifies each against `acdef43`):
  - `deno task lint`, `check`, `test`, `test:prop` green; `deno fmt --check` clean on every owned file.
  - Cancellation (`sqlite_ffi_cancel_test.ts`): an unbounded recursive CTE under `timeoutMs` rejects
    `SqliteCancelled({reason:"deadline"})`; each cancel latency < 25 ms and the median of 5 < 5 ms; a 2 ms
    timer chain keeps ticking and point reads on another connection keep running; the same for `AbortSignal`;
    an interrupted write inside `BEGIN` rolls back; four concurrent connections all meet their deadlines; the
    connection is reusable afterwards. Measured: 0.12 to 0.5 ms, p99 1.7 ms over 20 runs; loop max gap 3 to 12
    ms (vm-1, load 0.8 to 2.0).
  - Parity (`sqlite_ffi_perf_test.ts`): FFI sync point-read p50 ≤ 1.3 × `node:sqlite` p50 + 1 µs over 24 000
    interleaved reads per path, same rows from both; two _separate_ files, one per library (§1.2). Measured
    7.5 to 8.6 vs 7.8 to 8.6 µs; nonblocking 46 to 93 µs, p99 0.3 to 1.5 ms.
  - CRUD (`sqlite_ffi_crud_test.ts`): sync and async insert/select/update/delete, transactions, every storage
    class round-trips (U+0000 text, empty text, empty blob, int64 extremes under `readBigInts`), constraint
    failures carry extended codes, each contract breach is a typed error.
  - Resource safety: nothing can free a connection or statement a pool thread is using (`"busy"`); use after
    close/finalize is typed; the library is never `dlclose`d.
- **Review focus for Astra** (this plan's additions to the brief's list): every `UnsafePointer` lifetime
  against §1.3; that no JS-owned buffer is passed to the nonblocking symbol; that `interrupt` is only called
  while `inStep` and cannot leak into the next statement; that `closeAsync` cannot return while a pool thread
  is inside SQLite; that the `getCString` fast path cannot return a truncated string (length check); that
  `tests/unit/boundaries_test.ts` passes unchanged; that
  `grep -rn "Deno.dlopen" platform/ | grep -v
  platform/sqlite_ffi/` is empty. Gaps against the surface
  FFI-03 needs (`sqlite3_get_autocommit` is not bound; no statement cache) are **not** defects of this item —
  they are FFI-03's scope.

#### FFI-02 — Config options and library resolution

- **Scoping:** CONCURRENT with FFI-01 (disjoint files). Can start now.
- **Model:** **Haiku 5.5 / Luna (high)** — additive rows copying the item-08 options-table pattern (MT-02
  precedent), acceptance checkable by `deno task test`. Review: **Opus 5.5 / Astra**; lands only with a PASS
  and explicit human approval (AGENTS.md Haiku rule).
- **Branch / worktree:** `item/ffi-02-config` · `/root/Software/tsdb-work/ffi02`.
- **Owns:** `platform/config.ts` (additive rows only), `platform/services.ts` (additive `SqliteConfig` type
  and `Config.sqlite` field), `README.md` "Configuration" section (additive rows; this item also runs
  `deno fmt README.md`, which clears one of the three pre-existing fmt failures on `main`),
  `tests/unit/config_test.ts` (additive rows).
- **Reads:** `platform/config.ts` (options table), `platform/document_reader.ts` (the existing
  `readerCallTimeoutMs` semantics the new deadline must sit under), `platform/sqlite_ffi/library.ts` on
  `item/ffi-binding` (`DEFAULT_LIBRARY_PATHS`, `MIN_VERSION_NUMBER`) — read only, do not import it.
- **Work:** Add `sqliteLibrary` (env `SQLITE_LIBRARY`, string, **optional**, no default: when unset the
  binding's `DEFAULT_LIBRARY_PATHS` order applies; the description names the ≥ 3.37.0 gate and vm-1's two
  copies, 3.45.1 under `/usr/lib/x86_64-linux-gnu` and 3.53.4 under `/usr/local/lib`), `statementDeadlineMs`
  (env `STATEMENT_DEADLINE_MS`, number, default `5000`, finite and `> 0`, must be `< readerCallTimeoutMs` so
  the interrupt fires before the outer call gives up; the cross-field check fails `ConfigError`),
  `statementInterruptGraceMs` (env `STATEMENT_INTERRUPT_GRACE_MS`, default `1000`, `> 0`). Each row's
  description says what FFI-05 does at the deadline and at the end of the grace period.
- **Acceptance evidence:**
  - `ConfigLive` decodes the three options (`sqliteLibrary` absent → `undefined`); `0`, negative, non-finite
    and `statementDeadlineMs >= readerCallTimeoutMs` fail `ConfigError`, covered by new rows in
    `tests/unit/config_test.ts`.
  - Reviewer verifies README lists exactly the new options with the same defaults (item-08 parity rule) and
    that no file outside Owns changed.
  - `deno task ci` green (with the two remaining pre-existing fmt failures outside this item excepted).

#### FFI-03 — Effect integration layer over the binding

- **Scoping:** **SYNC.** After FFI-01 lands. Its exported surface is the contract FFI-04 and FFI-05 build on.
  Smaller than first planned: FFI-01 already delivers `Database`/`Statement`, both step paths, deadlines and
  abort; this item makes them Effect resources and adds the two things the platform callers need that the
  binding does not have.
- **Model:** **Opus 5.5 / Astra.** Scoped resource lifetimes and the interruption bridge.
- **Branch / worktree:** `item/ffi-03-effect` · `/root/Software/tsdb-work/ffi03`.
- **Owns:** `platform/sqlite_ffi/effect.ts` (new), `platform/sqlite_ffi/library.ts` (additive symbol
  `sqlite3_get_autocommit`), `platform/sqlite_ffi/database.ts` (additive `Database.inTransaction` only),
  `tests/unit/sqlite_ffi_effect_test.ts`, `platform/sqlite_ffi/mod.ts` (re-exports).
- **Reads:** `platform/sqlite_ffi/*` (FFI-01), `platform/sqlite.ts` and `platform/document_reader.ts` (the
  exact call shapes to replace: `prepare().all/get/run`, `exec`, `isTransaction`, `setReadBigInts`, `isOpen`,
  `close`), `platform/tenants/routing.ts` (`StorageLocation.open`).
- **Work:**
  1. `openDatabase(path, options): Effect<Database, SqliteFfiError, Scope>` — `Effect.acquireRelease` around
     `Database.open`; release calls `closeAsync` (cancels and waits for a pending execution, finalizes cached
     statements, closes).
  2. `Database.inTransaction` via `sqlite3_get_autocommit` — the replacement for `DatabaseSync.isTransaction`
     the writer's rollback path reads.
  3. Effect wrappers: `run/get/all` as `Effect.try` over the sync methods; `allAsync/runAsync/getAsync` as
     `Effect.async` that passes an `AbortController` signal and aborts it on **fiber interruption**, so an
     Effect `timeout` or scope close reaches `sqlite3_interrupt`; `SqliteCancelled` is surfaced as the typed
     failure (FFI-05 maps it to `StatementDeadlineError`).
  4. A bounded per-`Database` prepared-statement cache keyed by SQL text (LRU, capacity 64, finalize on
     eviction), bypassed for `VACUUM INTO` and DDL, so the writer's per-call `prepare(sql.text)` pattern keeps
     FFI-01's measured point-read cost.
- **Acceptance evidence:**
  - `tests/unit/sqlite_ffi_effect_test.ts`: scope close with a pending async execution cancels it and
    completes within 50 ms; `Effect.timeout` on `allAsync` yields `SqliteCancelled` and the connection answers
    the next statement; interrupting the fiber aborts the execution (observed as `reason: "aborted"`); cache
    eviction finalizes (statement count stays ≤ 64 through 500 distinct SQL texts); `inTransaction` flips
    across `BEGIN`/`COMMIT`/`ROLLBACK`; `BEGIN IMMEDIATE` on a second connection fails `SQLITE_BUSY` after
    `busyTimeoutMs`, as with `node:sqlite` today.
  - Point-read cost through the cached `get`: p50 ≤ 1.3 × `node:sqlite` p50 on the same run (FFI-01's perf
    test re-pointed one layer up).
  - `deno task ci` green; no `platform/` caller changed (FFI-04 does that).

#### FFI-04 — Cutover of the statement path to the binding

- **Scoping:** **SYNC, alone.** After FFI-02 and FFI-03. The §1.2 rule: every `node:sqlite` open of a live
  file in the API process switches in one commit.
- **Model:** **Opus 5.5 / Astra.** Transaction and writer-queue boundaries, snapshot semantics, test migration
  with a lock hazard. Review by the other top-tier model.
- **Branch / worktree:** `item/ffi-04-cutover` · `/root/Software/tsdb-work/ffi04`.
- **Owns:** `platform/sqlite.ts`, `platform/document_reader.ts`, `platform/tenants/routing.ts`,
  `platform/backup.ts`, `platform/layers.ts` and `platform/server.ts` (wiring the `Config.sqlite` library path
  into the open calls and the one-time lifecycle event), `tests/unit/boundaries_test.ts` (new rules),
  `tests/helpers/sqlite_inspect.ts` (new: open-for-inspection through the binding), and the test files that
  open live files directly: `tests/core_test.ts`, `tests/unit/storage_test.ts`, `tests/unit/backup_test.ts`,
  `tests/unit/document_reader_test.ts`, `tests/unit/http_test.ts`, `tests/unit/server_process_test.ts`,
  `tests/unit/server_scope_test.ts`, `tests/unit/reader_context_test.ts`, `tests/unit/nul_contract_test.ts`,
  `tests/unit/number_dialects_test.ts`, `tests/property/tenant_routing_props.ts`,
  `tests/property/storage_commit_test.ts`, `tests/layers/storage_test_layer.ts` (comment-only: it has no
  SQLite).
- **Reads:** `platform/sqlite_ffi/*` (FFI-01/03), `platform/config.ts` (FFI-02), `core/compile/*`,
  `core/errors.ts` (no new errors in this item).
- **Work:**
  1. `Storage` (`platform/sqlite.ts`): `DatabaseSync` → `openConnection(file, { readOnly: false })`;
     `database.prepare(sql.text)` → cached `Statement`; `isTransaction` → `inTransaction`; the three pragmas
     as three `exec` calls; `VACUUM INTO ?` unchanged in SQL, through `run`. **Semantics unchanged**: same
     `Semaphore(1)`, same `WRITER_QUEUE_CAP`, same `acquireUseRelease` transaction, same `nulProbe` contract,
     same `sql`/`tx` events. Every statement still takes the **blocking** path in this item.
  2. Document reader: per-call `openDatabase(file, { readOnly: true, readBigInts: true })` (the
     `setReadBigInts(true)` contract, unchanged); `statement.all` through the binding; throws mapped to
     `ReaderError` as today. The `Effect.timeoutFail` at `callTimeoutMs` stays for now (FFI-05 replaces it
     with the deadline).
  3. Router: `StorageLocation.open` returns the FFI connection (synchronously, inside the same `check` step —
     the containment and symlink re-check keeps its position); `prepare(location)` runs its DDL transaction on
     a short-lived connection and closes it.
  4. Backup: `verifySnapshot` and `integrityCheck` open the snapshot copy read-only through the binding.
  5. Lifecycle: one `lifecycle` event at startup with the resolved library path and `sqlite3_libversion()`.
  6. Boundary test: `platform/**` never mentions `node:sqlite` (replacing the two narrower rules); `tests/**`
     never mentions `node:sqlite` except `tests/property/sqlite_oracle_test.ts` and
     `tests/property/json_number_test.ts`, which run against in-memory databases nothing else opens (the
     oracle remains `node:sqlite` deliberately — a _different_ SQLite build is a better oracle than the one
     under test).
  7. Tests: replace every `new DatabaseSync(liveFile)` with `inspect(liveFile)` from the helper; where a test
     only needs to assert file contents after the server closed, keep the assertion and switch the opener.
- **Acceptance evidence:**
  - `deno task ci` green; `deno task integration` green; `deno task e2e` (MT-10) green — the whole existing
    suite is the regression oracle for "semantics unchanged".
  - `grep -rn "node:sqlite" platform/` is empty. `tests/unit/boundaries_test.ts` fails if it is not.
  - The segfault stress loop `work-scripts/bash/segfault-stress.sh` (30 runs of `deno task test`): no new
    crash signature beyond the known DuckDB teardown flake (gotchas "Exit-139").
  - `deno task perf:smoke` p50/p99 within 10 % of a `main` run on the same host and load (record both and the
    load averages in the commit body). Point-read latency is expected to drop; a rise fails the gate.
  - Snapshot round trip: `backup_test.ts` takes a snapshot, verifies it (`quick_check` through the binding),
    restores it — unchanged assertions pass.
  - Reviewer confirms no code path opens a file through both drivers (search for `DatabaseSync` across the
    repo; the two allowed oracle files use `:memory:` or their own temp files only).

#### FFI-05 — Classifier and deadline-bounded execution

- **Scoping:** **SYNC.** After FFI-04. Adds one error to the closed taxonomy, so it cannot run beside another
  item.
- **Model:** **Opus 5.5 / Astra.** Decides which statements can be interrupted, the error taxonomy change and
  its HTTP mapping, and what happens when an interrupt does not return. Review by the other top-tier model.
- **Branch / worktree:** `item/ffi-05-deadline` · `/root/Software/tsdb-work/ffi05`.
- **Owns:** `platform/sqlite_ffi/classify.ts` (new), `platform/document_reader.ts` and `platform/sqlite.ts`
  (path selection and deadline wiring), `core/errors.ts` (additive `StatementDeadlineError`),
  `platform/http/router.ts` (`toHttpStatus` row), `tests/errors_exhaustiveness.ts`, `core/events.ts` (additive
  optional `path: "blocking" | "nonblocking"` on `SqlPayload`), `docs/adr/0002-error-taxonomy.md` (one row),
  `tests/unit/ffi_classify_test.ts`, `tests/unit/document_reader_test.ts` and `tests/unit/storage_test.ts`
  (additive cases).
- **Reads:** `sdk/db.ts` (`SelectPlan`, `Operation`), `core/compile/select.ts` and `ddl.ts` (that `_id` is the
  primary key, so `_id = ?` is the indexed single-row lookup), `platform/config.ts` (FFI-02 options),
  `platform/sqlite_ffi/connection.ts` (FFI-03).
- **Work:**
  1. `classify(operation): "bounded" | "unbounded"`. Bounded: `insert`, `patch`, `delete`, and a `select`
     whose `filters` contain `{ field: "_id", op: "eq" }` with no `aggregate`. Unbounded: every other
     `select`, `count`, `countBy`. The rule is a pure function on the IR, unit-tested exhaustively; it never
     inspects SQL text.
  2. Document reader: bounded → `Statement.all` (blocking, unchanged); unbounded → `allNonblocking` raced with
     `statementDeadlineMs`. At the deadline the fiber is interrupted, FFI-03's handler calls
     `sqlite3_interrupt`, and the call fails
     `StatementDeadlineError { deadlineMs, elapsedMs, table,
     statementKind }`. The `tx` event records
     `outcome: "rollback"` with that error tag, as it does for any failure. The outer
     `Effect.timeoutFail(callTimeoutMs)` stays as the last-resort guard but, by FFI-02's cross-field check,
     can no longer fire first.
  3. Writer: the same rule inside a mutation's transaction. A bounded statement runs sync as today; an
     unbounded one (a handler's `find`/`count` inside a mutation) runs `allAsync` under the same deadline; on
     `StatementDeadlineError` the transaction's release half rolls back. The hot write still never waits
     behind a read: the writer connection runs one statement at a time under `Semaphore(1)` exactly as before.
  4. `StatementDeadlineError` → HTTP **504**; `errorMessage` names the deadline; `PlatformError` union and
     `errors_exhaustiveness.ts` updated; ADR 0002 gets its row. The reader-call timeout (`IpcError{timeout}` →
     502) is unchanged for ingest/analysis calls.
  5. **Grace period.** If the interrupted step has not returned `statementInterruptGraceMs` after `interrupt`,
     emit an `error`-level `lifecycle` event (`"statement did not return after interrupt"`) and mark the
     connection poisoned: no further statements; it is closed when the step finally returns. There is no lane
     to kill in this plan (§6); the event is the signal an operator and the future lane supervisor act on.
  6. `SqlPayload.path` set on every `sql` event (`"blocking"`/`"nonblocking"`); the DuckDB `sql_events`
     projection gains a nullable `path` column in FFI-06.
- **Acceptance evidence:**
  - `tests/unit/ffi_classify_test.ts`: every `Operation` shape the SDK can produce is classified; a property
    over generated `SelectPlan`s asserts `bounded ⇔ (_id eq filter present ∧ no aggregate)`.
  - Document reader test: a seeded 200 000-row table, a `count` with `statementDeadlineMs = 50` →
    `StatementDeadlineError` within `50 ms + 20 ms` wall clock (PoC interrupt 0.4 ms, outliers to 9 ms), the
    `sql` event shows `path: "nonblocking"`, `outcome: "error"`, `errorTag: "StatementDeadlineError"`; the
    `tx` event shows `rollback`. A concurrent point read on another file completes in < 5 ms during the long
    statement (the §3.1 property, in-process).
  - Writer test: a mutation whose handler runs an unbounded `find` past the deadline rolls back (no row
    committed), fails 504, and the next mutation on the same connection succeeds.
  - Point reads stay blocking: `sql` events for `get`-by-id show `path: "blocking"`; p50 unchanged from
    FFI-04's run.
  - `deno task ci`, `integration`, `e2e` green;
    `grep -c "StatementDeadlineError" tests/errors_exhaustiveness.ts` ≥ 1.

#### FFI-06 — Perf harnesses, integration evidence and the event-log column

- **Scoping:** CONCURRENT with FFI-07. After FFI-05.
- **Model:** **Sonnet / Sol** (`sonnet`, `gpt-6.1-sol`). Porting measured scripts to the landed API; checkable
  thresholds. Review: Opus 5.5 / Astra.
- **Branch / worktree:** `item/ffi-06-evidence` · `/root/Software/tsdb-work/ffi06`.
- **Owns:** `perf/ffi_read_cost.ts`, `perf/ffi_interrupt.ts`, `perf/README.md` (additive),
  `tests/integration.ts` (additive scenario), `platform/eventlog/tables.ts` and `core/eventlog/ddl.ts`
  (additive nullable `path` column on `sql_events`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS` on ingest),
  `platform/analysis/catalog.ts` (one additive query: deadline hits per handler per hour),
  `work-scripts/INDEX.md` (rows marking the PoC scripts as superseded by the `perf/` ports).
- **Reads:** `work-scripts/deno/ffi-sqlite-read-cost.ts`, `ffi-sqlite-interrupt.ts`, `bash/lang-switch-poc.sh`
  (on `research/fable-lang-switch`), `platform/sqlite_ffi/*`,
  `docs/architecture/lang-switch-fable-data/*.json` (the numbers to compare against).
- **Work:**
  1. Port the two PoC scripts to the binding and FFI-03's `Statement`, same JSON output shape as the PoC so
     the committed PoC JSON is directly comparable; run with `deno run -A perf/ffi_*.ts` (no new `deno.json`
     task — the file is frozen, as the demos item recorded).
  2. `tests/integration.ts`: start the server, seed a tenant with enough rows that `count` exceeds a 50 ms
     deadline, fire it alongside point reads on a second tenant; assert 504 for the count, < 50 ms p99 for the
     point reads during it, and that `logs:query` shows the `sql` event with `path: "nonblocking"`.
  3. Event-log `path` column and the catalog query.
- **Acceptance evidence:**
  - `perf/ffi_read_cost.ts` on vm-1: blocking p50 ≤ the PoC's 6.8 µs × 1.5 and ≤ `node:sqlite`'s p50 in the
    same run; nonblocking p50 ≤ 100 µs, p99 ≤ 3 ms; load average recorded.
  - `perf/ffi_interrupt.ts`: 50 iterations, interrupt latency p99 ≤ 20 ms, loop ticks ≥ 90/100.
  - Concurrency at the cap: 32 concurrent unbounded statements all hit a 50 ms deadline within 50 ms + 50 ms
    each (no pool starvation at the document-read cap); this is the measurement study §9 said was missing.
  - `deno task integration` green with the new scenario; `deno task logs:ingest && deno task logs:query` shows
    the `path` column populated.
  - `deno task ci` green.

#### FFI-07 — Property tests for the binding and the deadline

- **Scoping:** CONCURRENT with FFI-06. After FFI-05.
- **Model:** **Sonnet / Sol.** The interfaces are fixed; the work is generators and invariants in the item-13
  style.
- **Branch / worktree:** `item/ffi-07-props` · `/root/Software/tsdb-work/ffi07`.
- **Owns:** `tests/property/ffi_roundtrip_test.ts`, `tests/property/ffi_interrupt_test.ts`, `docs/testing.md`
  (additive rows).
- **Reads:** `platform/sqlite_ffi/*`, `tests/property/sqlite_oracle_test.ts` (generators to reuse),
  `tests/property/json_number_test.ts`, `tests/unit/nul_contract_test.ts`.
- **Work:**
  1. Round trip: for generated values of every column kind (text with NULs and lone surrogates, integers
     across the full int64 range, doubles including `-0`, `NaN` rejected, blobs), `bind → step → column`
     through the binding equals the value `node:sqlite` returns for the same bind on a _separate_ in-memory
     database — except U+0000 text, where the binding returns the full string and `node:sqlite` the truncated
     one (the property pins the difference explicitly, ADR 0005).
  2. Interrupt totality: for random statements and random interrupt delays (0 to 50 ms) a nonblocking step
     always terminates with either rows or `SQLITE_INTERRUPT`, never hangs, and the connection answers the
     next statement; run 200 iterations.
  3. Classifier property (shared with FFI-05's unit test if FFI-05 landed it; otherwise here).
- **Acceptance evidence:** `deno task test:prop` green with the two new suites; a 200-seed sweep (gotchas
  "seed sweep") finds no failure other than known exit-139 reruns; `docs/testing.md` lists the suites.

#### FFI-08 — Docs, C4 diagrams, ADR and knowledge

- **Scoping:** After FFI-06 and FFI-07. **Docs-only** (CLAUDE.md rule: no edits under `core/`, `platform/`,
  `sdk/`, `app/`, `tests/`, `scripts/`, `perf/`, `deno.json`).
- **Model:** **Haiku 5.5 / Luna (high)** — docs-only with a fixed checklist (precedent: SP-08 docs, Luna
  build, review PASS). Review: Opus 5.5 / Astra; lands only with a PASS and explicit human approval.
- **Branch / worktree:** `item/ffi-08-docs` · `/root/Software/tsdb-work/ffi08`.
- **Owns:** `docs/architecture/c4-component-server.*` and `c4-container-platform.*` with their `diagrams/*.py`
  sources (the `node:sqlite` box becomes "FFI binding → system libsqlite3"; edge labels name the two step
  paths), `docs/architecture/README.md`, `docs.md` and `README.md` (usage: the 504 deadline, the three
  options), `docs/adr/0006-statement-execution-via-ffi.md` (decision, the §1.2 rule, the §1.3 threading model,
  the measured numbers), `docs/knowledge/decisions.md` and `gotchas.md` (two SQLite copies; two `libsqlite3`
  on vm-1; `getCString` truncation), `docs/plans/ffi/README.md` (status line: execution layer landed,
  lanes/placement still proposed), `docs/plans/ffi-implementation.md` (this file: status → landed).
- **Reads:** the landed diffs of FFI-01 … FFI-07.
- **Acceptance evidence:** `python3 docs/architecture/diagrams/render.py --check` passes; both formats of each
  touched diagram updated; the ADR cites the FFI-06 numbers; `deno fmt --check docs/` green; a reviewer
  re-verifies the diagrams against `platform/` (AGENTS.md: a "diagrams current" claim must be re-verified).

## 5. Risks

| #  | Risk                                                                                          | Handling                                                                                                                                                                                                                                                                     |
| -- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Two SQLite copies open the same file in one process and corrupt each other's POSIX locks      | §1.2: one SYNC cutover (FFI-04); boundary test forbids `node:sqlite` under `platform/`; tests inspect through the binding; the two oracle tests use private in-memory databases                                                                                              |
| 2  | A pointer bug in the binding is a native crash of the API process, with no lane to contain it | Opus/Astra build and independent top-tier review of FFI-01/03 against §1.3; one statement per connection; no `UnsafeCallback`; FFI-07 interrupt-totality and round-trip properties; the segfault stress loop in FFI-04's gate. Lanes remain the designed isolation unit (§6) |
| 3  | Wrong `libsqlite3` picked up (vm-1 has 3.53.4 and 3.45.1 under different paths)               | Explicit `SQLITE_LIBRARY` option; `libversion_number ≥ 3045000` gate; the resolved path and version in a startup `lifecycle` event                                                                                                                                           |
| 4  | Nonblocking tail (p99 0.24 to 2.2 ms) shows up on the HTTP p99                                | Only unbounded statements take the path (classifier); FFI-04 and FFI-06 gates on `perf:smoke` p99 within 10 % of `main`                                                                                                                                                      |
| 5  | An interrupted statement never returns (pathological VFS wait, a bug)                         | Grace period → `error` lifecycle event and a poisoned connection (FFI-05 step 5). The process cannot kill itself; the designed remedy is the lane supervisor, out of scope here and recorded as the first lane item's acceptance                                             |
| 6  | Deno's blocking pool saturates under many concurrent long statements                          | The 32-permit document-read cap bounds it; FFI-06 measures 32 concurrent deadline hits; the per-tenant sub-cap belongs to the lane design                                                                                                                                    |
| 7  | `i64` crossing as `number` or `bigint` inconsistently                                         | FFI-01 normalises to `bigint`; `number_dialects_test` and `json_number_test` are the oracle; FFI-07 sweeps the int64 range                                                                                                                                                   |
| 8  | Lossless NUL reads silently change the stored-text contract                                   | ADR 0005 stays: rejection before commit, `nulProbe` unchanged (FFI-04); the property in FFI-07 pins the driver-level difference; relaxing the contract is a separate decision (§6)                                                                                           |
| 9  | The in-flight Opus FFI-01 slice diverges from this item's surface                             | The reviewer judges the slice against FFI-01's acceptance list; gaps become FFI-01 NITS or move into FFI-03's scope — never a second binding                                                                                                                                 |
| 10 | A Deno upgrade changes FFI representation or stability                                        | Deno stays pinned at 2.9.5 for this plan; any bump re-runs FFI-01 and FFI-06 acceptance                                                                                                                                                                                      |
| 11 | Shared, loaded VM distorts latency gates                                                      | Every gate is a ratio against a same-run `node:sqlite` or `main` measurement, with load average recorded (gotchas "The VM is shared and loaded")                                                                                                                             |

## 6. What explicitly does NOT change

- **Lanes.** No child-process lanes are built here. The API process remains the only process touching tenant
  files, as on `main`; the DuckDB reader child, its IPC and supervision are untouched. The lane design in
  `docs/plans/ffi/` (statement lane process, write-first scheduler, handle pool, request-id store, lane
  supervisor) stays the isolation unit of the _target_ architecture, unchanged, and becomes its own plan once
  this one lands. The binding and connection API are written so they move into a lane without change: no
  module-level state beyond the `dlopen` singleton, all lifetimes scoped.
- **Placement.** No `placement` table, router or forwarder. The `TenantStorageRouter` seam and
  `"control-plane"` reservation stay as MT-04 left them.
- **The write model.** `Semaphore(1)` per writer, `WRITER_QUEUE_CAP = 1000`, `BEGIN IMMEDIATE`,
  `acquireUseRelease` transactions, `synchronous=FULL`, WAL, `busy_timeout=5000`, `VACUUM INTO` snapshots on
  the writer lock. Point reads and single-row writes stay synchronous.
- **The read model's admission.** The 1000-pending admission cap and `QueueFullError{queue:"reader"}`
  contract, the 32-permit execution cap, one read-only connection per handler call.
- **The storage contracts.** ADR 0005 (U+0000 rejected before commit), the `json`/`columns` layouts, the
  compiled SQL (`GENERATED_SQL.txt` byte-identical), the `_platform_schema` fingerprint check, known
  divergence 3 (lone surrogates).
- **The SDK and client.** `createClient`, named handlers, the `Operation` IR, the HTTP routes. The only
  client-visible change is that a long statement now fails 504 with `StatementDeadlineError` instead of
  hanging the loop or failing 502 while still running.
- **The two-process native-library split.** The reader never loads SQLite; the API process never loads DuckDB.
  The boundary test keeps both rules and gains the `node:sqlite`-free `platform/` rule.
- **Backups, object storage, event-log ingest, analysis catalog, logging, retention, tenancy, auth.** Apart
  from the additive `path` column and one catalog query (FFI-06), none of these items' files change.
- **`deno.json`.** Frozen; no new task. Perf scripts run with `deno run -A`.

## 7. Evidence this plan builds on

- Measurements: [lang-switch-fable.md §3](../architecture/lang-switch-fable.md) and the raw JSON in
  [`lang-switch-fable-data/`](../architecture/lang-switch-fable-data/) (vm-1, 2026-10-12, load 3.3 at the
  committed run). Harnesses: `work-scripts/INDEX.md` rows for `ffi-sqlite-interrupt.ts`,
  `ffi-sqlite-read-cost.ts`, `lane-kill-latency.ts`, `lang-switch-poc.sh` on `research/fable-lang-switch`.
- Design: [docs/plans/ffi/README.md](ffi/README.md) (C4 set and the four flows),
  [architecture-ste100.md](ffi/architecture-ste100.md), `docs/architecture/scale-out-final-fable.md` §Tweaks
  on `arch/fable-ranking` (lanes as child processes, request ids, hot-tenant pinning — all deferred with the
  lanes).
- Precedent for a one-item cutover without a flag: `docs/plans/sqlite-pivot.md` SP-02 (`plan/sqlite-pivot`).
- Constraints: `docs/plans/effect-port-and-observability.md` §0 "the hard architectural constraint", §2.2
  (`deno.json` freeze, ownership rules); `AGENTS.md` (model policy, review, event log);
  `docs/adr/0005-text-storage-contract.md`.
