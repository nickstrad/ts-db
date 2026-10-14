# Independent Astra review: FFI-05

**Verdict: FAIL.** Reviewed `6246f9d` (implementation `05bd838`, brief `e853ea5`, knowledge `6246f9d`) against
`702c354`. Actor: `astra-ffi-05-review`. Date: 2026-10-14. Only review artifacts under `agent-work/` were
changed. No implementation fixes or merges.

## Numbered defects

1. **P2 — A queued document read can execute after its transaction and context have ended.**
   `platform/document_reader.ts:221` and `:229` check only poisoning after the gate wait. The context check at
   `:283` happens before that wait. In addition, the COMMIT callback at `:355` does not expire the context
   atomically with COMMIT (unlike the writer at `platform/sqlite.ts:702`). A handler can fork a long count,
   fork a delayed point read, and return while the count is running. COMMIT queues first; the point read
   subsequently passes the still-active context check and queues behind COMMIT. When the count settles, COMMIT
   runs, but the queued read still attempts native work. With an immediate event sink it reaches a closed
   connection and fails `ReaderError` with `prepare on a closed connection`. With a sink that yields for 5 ms
   when recording the transaction, the read **succeeds after COMMIT and after context expiry**, outside the
   query's snapshot. SQL events can consequently appear after the transaction's completion event.

   Reproduce from this checkout:

   ```sh
   export PATH="$HOME/.deno/bin:$PATH"
   deno run -A agent-work/items/ffi-05-deadline/review-reader-race.ts delay-sink
   deno run -A agent-work/items/ffi-05-deadline/review-reader-race.ts
   ```

   The diagnostic prints exits and native/event ordering; it does not assert the expected failure. The fixture
   is a real 200,000-row JSON table. Prototype wrappers only record calls and delegate unchanged. At load1
   1.46, the delayed-sink run printed `late: Success` with row `id-1`, and order
   `COMMIT → tx commit → Statement.all(SELECT ... _id ...) → sql ok`. The immediate-sink run printed
   `ReaderError`, with its stack at `document_reader.ts:224`. A control using the reader module from
   `702c354`, with imports redirected to this checkout's dependencies, returned `ContextExpiredError` and
   performed no late SQL. See the committed `review-evidence/reader-race-*.log` files.

   Required repair: carry the query context into both gate start paths, recheck it after waiting, and expire
   it in the same synchronous callback as COMMIT. Add a regression for queued escaped reads, covering both
   blocking and nonblocking plans. The writer already demonstrates the appropriate guard placement. This is a
   reproducible context/snapshot regression, not a timing-budget failure.

2. **P3 / nonblocking nit — The new gate tests violate the blocking callback contract.**
   `tests/unit/storage_test.ts:930` returns `Effect.sync(() => nativeCall())` from `gate.blocking`; the grace
   fixture repeats that pattern at `:960` and `:980`. The gate contract at `platform/sqlite.ts:329` requires
   the native call to happen synchronously inside `start`, before returning an Effect. These tests currently
   pass because they do not introduce a competing claimant at that boundary, but they demonstrate the unsafe
   usage the implementation explicitly warns against. Make the native call in the callback and return its
   completed result as an Effect; retain/add a competing-claim regression. Production writer calls and reader
   `nativeNow` satisfy this requirement.

## Validation performed independently

Suites ran sequentially. All requested standard checks passed; they do not cover defect 1. The full logs
remain in this worktree's `review-evidence/`; selected probe logs are committed.

| Command                                                      | Observed result                                                                                                 | Load1 at start, where recorded |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `deno task lint`                                             | `Checked 164 files`, exit 0                                                                                     | 0.44                           |
| `deno task check`                                            | All configured roots, including error exhaustiveness, exit 0                                                    | 0.44                           |
| `deno task test`                                             | `684 passed / 0 failed / 1 ignored` (4m35s), exit 0                                                             | 1.00                           |
| `deno task test:prop`                                        | `79 passed / 0 failed` (2m31s), exit 0                                                                          | 1.69                           |
| `deno task integration`                                      | PASS: both layouts, read-after-write, aggregation, isolation, backup/restore, auth, traces, ingest and analysis | 2.28                           |
| `deno fmt --check` on `git diff --name-only 702c354 6246f9d` | `Checked 15 files`, exit 0                                                                                      | —                              |
| `git diff --check 702c354 6246f9d`                           | exit 0                                                                                                          | —                              |
| `npm run e2e`                                                | 7 passed / 0 failed; E2E PASS, no skipped scenarios, exit 0                                                     | 1.09                           |
| Review probe type-check                                      | Both review scripts passed `deno check`                                                                         | —                              |

Observed timing output, with no load-based relaxation (4 CPUs):

- Reader deadline 50 ms: statement 51.3 / 51.6 / 51.2 ms; call wall 57.6 / 55.1 / 55.2 ms, median 55.2, bound
  70 ms; load1 1.25.
- Concurrent point reads: 4.52 / 3.46 / 2.27 / 2.19 / 2.45 ms; median 2.45, bound 5 ms; load1 1.25. All five
  blocking reads finished before the nonblocking count's error event.
- Writer: statement 52.7 ms, mutation 57.1 ms; load1 1.76. The failed mutation's insert was absent, the next
  mutation on the same connection committed, and SQL/transaction error tags matched.
- Native stuck-step fixture: deadline 30 + grace 100 ms, notification at 164.3 ms, return at 604.7 ms with
  busy timeout 600 ms; load1 1.76. Connection closed before the queued caller proceeded.
- Supplemental `review-gate.ts`: 100 immediate/1-ms-delayed fiber interruptions, each followed by a successful
  blocking call; no late watchdog notification after waiting beyond deadline + grace. Also exercised a real
  busy wait with an explicit transaction open: poisoned, closed, `inTransaction === false` before the gate's
  next caller. Both passed at load1 2.01.

## Review findings beyond the defects

- **Classifier:** pure IR switch, exhaustive over `Operation`; count/countBy are select aggregates. Only
  no-aggregate `_id` equality selects are bounded; writes stay bounded. Tests capture actual SDK operations
  and run 2,000 generated plans, explicitly requiring both classifications to be reached.
- **Execution paths:** reader unbounded selects use `allAsync` with binding `timeoutMs`; writer unbounded
  reads and their NUL probes use `allAsync`/`getAsync`. Writes, PK reads, pragmas, DDL, transaction control
  and snapshots remain synchronous. The writer semaphore and queue cap are unchanged.
- **Gate lifecycle:** the idle check and claim occur in one synchronous step. Waits restore interruption;
  claim/fork/finalizer installation are masked. The async wrapper's cancellation finalizer waits for the
  native execution, then the gate interrupts/joins its watchdog, closes if poisoned, and releases its
  deferred. Waiters recheck the claim, preventing lost wakeups if a new claimant wins first. Production
  blocking callbacks do native work immediately. No gate deadlock or leaked watchdog was observed in the
  interruption probe. The reader's missing context guard is separate from gate ownership.
- **Grace and poisoning:** the real-timer watchdog handles the binding's uninterruptible busy wait. That
  native step returns `SqliteError(SQLITE_BUSY)`, not `SqliteCancelled(deadline)`, so the platform correctly
  retains `StorageError`/`ReaderError` and rollback rather than falsely reporting a successful interrupt. A
  stuck lifecycle event precedes settlement. Closed handles report no transaction. The absence of an
  end-to-end poisoned WAL-writer fixture is a coverage hand-off, not an additional blocking defect:
  shared-gate tests, the supplemental open-transaction probe, poison guards, and the writer's release logic
  support the safety argument. Normal writer deadline rollback is tested end to end.
- **Provenance and cleanup:** deadline mapping consumes only the Effect layer's binding-owned typed channel;
  caller-thrown values remain defects upstream. It does not infer ownership from a cancellation class. Binding
  identity tracking and native-error-before-caller-cleanup sequencing are unchanged. New preparation defects
  use `Effect.failCause(Cause.die(cause))`. Cached statements are protected by the claim until execution;
  blocking fetch/use is immediate. Existing handler-error inspection is pre-existing and is not broadened into
  a new binding provenance mechanism.
- **Taxonomy/services:** placing the new tag at `DbError` is sound here: SDK operations and server-facing
  services carry it, while DuckDB and IPC do not produce it. `StorageService.mutation` is explicitly widened;
  the generic client's default retains the original IPC error union, and only the server tag gains the wider
  channel. Type exhaustiveness remains closed and passes. HTTP mapping is 504, message names the deadline, IPC
  timeout stays 502, and ADR 0002 has the row.
- **Events:** all writer/reader SQL event construction sites set `path`. In-memory events preserve it;
  `KIND_KEYS.sql` omits it from JSONL. This is a logging gap, not an execution or golden-test regression.
  Ordinary deadline cases emit the expected SQL error and transaction rollback tags.
- **Timing tests:** not vacuous: they require the precise typed failure, metadata, event counts/order, real
  point-read results, and committed/rolled-back row counts. Load scaling is disclosed, and this review passed
  the original unscaled bounds. The load factor is not itself a same-run baseline ratio; FFI-06 should supply
  the plan's stronger contended-host comparison. Existing `ConfigTest` calls at reader-test lines 127/334
  bypass cross-field decoding and retain older equal/lower call timeouts; those lines were not changed by
  FFI-05. New deadline cases use 50 ms below the default call timeout.
- **Performance:** the builder's reported p50 increases of 4.2%/3.2% are within the stated 10% rule and its
  point-read p50 is unchanged. I did not rerun k6 or independently obtain its raw artifacts. The per-row pool
  cost on countBy/listGames is confined to the accepted unbounded path and cannot be removed by editing this
  item's owned files without changing the binding. It is a follow-up, not a defect.
- **Ownership:** all 15 changed files are within the brief plus the explicitly permitted additions
  (`platform/services.ts`, `tests/unit/http_test.ts`, knowledge, and item artifacts). No binding, SDK,
  compiler, DuckDB, IPC, frozen configuration, or unrelated test file was changed.

## Coordinator/plan hand-offs and learning assessment

1. Repair defect 1 in a fresh unit and re-review its delta; include the queued-reader context regression.
   Durable project lesson: validity checks made before an asynchronous connection wait must be repeated at
   native start, and context expiry belongs in the transaction-ending synchronous step. Preserve this in
   `docs/knowledge/` through its authorized owner; this committed report is the ownership-safe hand-off.
2. Extend FFI-06 ownership to `core/events.ts` and its golden test when adding `KIND_KEYS.sql.path`, alongside
   the planned DuckDB projection. Otherwise the projection has no persisted path values to ingest.
3. Record a binding follow-up to batch row steps per pool call while retaining cancellation and lifetime
   invariants. Retain the original raw perf evidence and remeasure at the 32-reader cap in FFI-06.
4. Add an end-to-end WAL-writer poison fault-injection seam when an authorized binding/test unit can own it;
   preserve the existing real busy-wait test as the native stuck-step oracle.
5. Restore valid deadline/call-timeout pairs in the older ConfigTest fixtures when their owner next edits
   them. Optional maintenance: consolidate the duplicate IPC call-error alias and refresh old config wording.

No new VM/environment knowledge was learned; no kb write is appropriate. The review scripts are narrow
reproduction/evidence artifacts, not additions to the reusable work-script library. No ownership expansion was
made. Keep this worktree for coordinator inspection; the coordinator can remove it after inspection.
