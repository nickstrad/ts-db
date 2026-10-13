# FFI-01 — production FFI SQLite binding (brief)

Status: built, awaiting review · Branch: `item/ffi-binding` · Worktree: `/root/Software/tsdb-work/ffi-binding`
· Base: `main` at `dedef4f` · Builder: Claude Opus 5.5 (`claude-ffi-binding`) · Date: 2026-10-13 · Task: Nick,
`/root/ffi-build-task.md`.

## Why

Fable's language-switch study (`docs/architecture/lang-switch-fable.md` on `research/fable-lang-switch`, §3
and §8) measured that Deno FFI to the system `libsqlite3` gives what `node:sqlite` lacks: a `nonblocking`
`sqlite3_step` that runs on a pool thread while the event loop stays live, and `sqlite3_interrupt` from the
main thread that stops it in under a millisecond. Its recommendation step 1 is an own binding of about 200
lines. This item is that binding, production quality, and nothing that uses it yet.

## Scope

- `platform/sqlite_ffi/`: load and validate `libsqlite3` (version ≥ 3.37, threadsafe); open/close; exec;
  prepare (exactly one statement); bind positional and named parameters; synchronous `run`/`get`/`all`;
  nonblocking `runAsync`/`getAsync`/`allAsync` with a per-execution deadline (`timeoutMs`) and `AbortSignal`,
  both enforced by `sqlite3_interrupt`; `closeAsync` that cancels and waits; typed errors.
- Tests proving: (a) a never-ending query is cancelled within a few ms of its deadline while the event loop
  stays responsive; (b) point-read p50 parity with `node:sqlite`; (c) ordinary CRUD correctness.

Out of scope (follow-up items): moving `platform/sqlite.ts` / `platform/document_reader.ts` onto the binding;
mapping the binding's tags into `core/errors.ts`'s `PlatformError`; a bounded statement pool with per-tenant
caps; the statement classifier; lanes. `deno.json` is untouched (item-01 rule): the tests sit under
`tests/unit/` and run in `deno task test`.

## Acceptance criteria

1. `deno task lint`, `check`, `test`, `test:prop` green; `deno fmt --check` clean for every file this item
   owns. (`deno task fmt:check` is red on `main` at `dedef4f` from three files outside this item: `README.md`,
   `docs/knowledge/decisions.md`, `docs/architecture/README.md`.)
2. Cancellation: `tests/unit/sqlite_ffi_cancel_test.ts` — an unbounded recursive CTE under `timeoutMs` rejects
   `SqliteCancelled({ reason: "deadline" })`, each cancel latency < 25 ms and the median of 5 < 5 ms; a 2 ms
   timer chain keeps ticking and point reads on another connection keep running throughout; same for
   `AbortSignal`; an interrupted write inside `BEGIN` rolls back; four concurrent connections all meet their
   deadlines; the connection is reusable afterwards (no lingering interrupt).
3. Parity: `tests/unit/sqlite_ffi_perf_test.ts` — FFI sync point-read p50 ≤ 1.3 × `node:sqlite` p50 + 1 µs
   over 24,000 interleaved reads per path, same results from both.
4. CRUD: `tests/unit/sqlite_ffi_crud_test.ts` — insert/select/update/delete sync and async, transactions,
   every storage class round-trips (including text with U+0000, empty text, empty blob, int64 extremes under
   `readBigInts`), constraint failures carry extended codes, and each contract breach is a typed error.
5. Resource safety: no call can free a connection or statement while a pool thread uses it (`"busy"`), use
   after close/finalize is a typed error, and the library is never `dlclose`d.

## Design decisions for the reviewer

- **One execution per connection.** While an async execution is in flight every other call on that connection
  fails `SqliteUsageError("busy")`. Alternatives were blocking on SQLite's FULLMUTEX (stalls the event loop,
  defeating the point) or queueing (hides back-pressure; belongs in the pool item).
- **Interrupt only while inside a step.** `cancel` calls `sqlite3_interrupt` only when a pool thread is in
  `sqlite3_step_nb`; between steps it sets a flag the loop checks. With every execution running to completion
  and resetting, no other statement is active on the connection, so a racing interrupt is cleared by SQLite
  when the next statement starts.
- **Errors are binding-local tags** (`platform/sqlite_ffi/errors.ts`) with structured fields, like
  `core/errors.ts`; joining them to `PlatformError` is the migration item's call.
- **Sync calls are unbounded by design**, as the study prescribes: the thread that would interrupt is the one
  running the statement. A progress-handler watchdog was rejected: the same connection also steps on pool
  threads, where a JS callback would be called off its isolate thread.
- **Point-read cost** comes from cached column names (invalidated by `SQLITE_STMTSTATUS_REPREPARE`), a
  `getCString` fast path for ASCII text, int32 binds and `column_double` integer reads (no bigint), and
  skipping `clear_bindings` unless SQLite holds a text/blob copy.

## Measured (vm-1, 2026-10-13, load 0.8–2.0)

Cancel latency 0.12–0.5 ms (p99 1.7 ms over 20 runs); event loop max gap 3–12 ms during a 150–200 ms
statement. Point read p50 µs: `node:sqlite` 7.8–8.6, FFI sync 7.5–8.6, FFI nonblocking 46–93 (p99 0.3–1.5 ms).
Reproduce with `work-scripts/deno/ffi-binding-bench.ts`.
