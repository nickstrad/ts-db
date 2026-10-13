# FFI-04 independent review — FAIL

Reviewed `73f882f` (implementation `ae48f24`, knowledge `a6f87f3`, brief `73f882f`) against base `182e85d`.
Reviewer: Codex Astra, actor `astra-ffi-04-review`, branch `review/ffi-04-astra`, 2026-10-13. No product files
were edited. The two-copies acceptance criterion is violated.

1. **Blocking: an exempted oracle opens the same live file through both SQLite copies.**
   `tests/property/sqlite_oracle_test.ts:316` acquires `makeStorage({ file, schema })`; after this cutover
   that holds an FFI connection until the enclosing test scope closes. At **line 342**,
   `new DatabaseSync(file)` opens exactly that file, and line 348 closes it while Storage is still alive
   (Storage is used again at line 350). Both `columns` and `json` regressions execute this path.
   `tests/unit/boundaries_test.ts:214` exempts the whole oracle file under an incorrect separate-files
   assumption, so green boundary/property tests do not establish plan §1.2. This creates the POSIX lock-table
   hazard the atomic cutover must eliminate. The test predates this commit, but replacing its Storage
   implementation with FFI introduces the mixed-copy use.

   Reproduce with `deno task test:prop --filter "oracle regression 2"`; inspect the overlapping acquisitions
   above. I also ran an instrumented scratch copy that records the actual Database returned by `Database.open`
   and checks its `isOpen` immediately before the node opener. Both cases fail with `true !== false`, proving
   overlap without relying on a sporadic lock failure. Repair requires expanding the repair unit’s ownership:
   this oracle was expressly excluded from the builder’s Owns set. Use the FFI inspection helper for the
   live-file bypass; retain the old-driver truncation oracle only on a separate file or in-memory database.
   Keep the rejection/read-contract assertions. Re-audit every allow-listed file’s actual open paths.

2. **Scope variance: a comment-only file has an executable edit.** `tests/layers/storage_test_layer.ts:471`
   changes the `StorageError.detail` string, although the brief and plan authorize this file only for
   comments. Reproduce with `git diff 182e85d ae48f24 -- tests/layers/storage_test_layer.ts` (the final hunk).
   The change correctly keeps the double consistent with the live storage contract; I do not recommend
   reverting it. It nevertheless exceeds the stated edit scope and is not among the three coordinator-approved
   comment-only exceptions. The coordinator should explicitly record this additional scope acceptance when
   assigning the repair. This is a scope finding, not a separate runtime defect.

3. **Non-blocking formatting nit in the committed brief.** `agent-work/items/ffi-04-cutover/brief.md:5` (and
   later paragraphs) does not pass explicit `deno fmt --check agent-work/items/ffi-04-cutover/brief.md`. All
   26 implementation files and the knowledge change pass; checking all 28 changed files reports only this
   brief. Format the brief in the metadata follow-up. This ignored coordination file does not affect runtime
   or the normal repository-wide formatter’s input set.

The DQS/foreign-key difference is **acceptable for landing this item once finding 1 is repaired**, with the
coordinator’s binding-defaults follow-up retained. It is not another FAIL or NIT. `core/compile/ddl.ts` emits
no foreign keys; select/write compilation resolves fields against the schema and binds values. I found no
supported generated-SQL path whose result changes because of these two defaults. DQS-on does weaken detection
of compiler mistakes or externally damaged schema; restore DQS_DML/DQS_DDL off and foreign_keys on in the
separately owned binding item, with tests. This judgment does not claim general raw-SQL compatibility with the
old driver.

The rest of the cutover passes source review:

- The API writer, document reader, router, and snapshot verifier all use the FFI binding. The migrated
  live-file side connections use `inspect`. Remaining node-driver opens in the two binding suites use distinct
  `node.db` files; the numeric oracle uses memory. The standalone `work-scripts/deno/ffi-binding-bench.ts`
  also imports the node driver, on a separate `node.db`; it is not reachable from either process root. Finding
  1 is the exception in the schema oracle.
- Storage retains `Semaphore(1)`, `WRITER_QUEUE_CAP`, guarded synchronous statement execution,
  `acquireUseRelease`, the NUL probe, SQL/transaction events, rollback checks, and queue-draining synchronous
  close. Every `prepareCached` result is consumed in the same synchronous step; binds are arrays. No async
  statement execution or native deadline was introduced.
- Document reads open per call with `readOnly` and `readBigInts`; `ReaderError` mapping, rollback/close
  logging, and `Effect.timeoutFail` at `callTimeoutMs` remain. Router containment and sidecar/symlink checks
  immediately precede its synchronous open; preparation always closes its short-lived connection. Snapshot
  verification opens read-only, and round-trip assertions are preserved.
- `sqliteFailureMessage` reads the binding’s captured error fields; the writer, document reader, backup and
  startup paths use it. Its class predicate selects message formatting, not error ownership or permission to
  mutate caller exceptions. This item adds no caller cleanup hooks or mutation of caught binding errors.
  Native error capture and identity-based cleanup remain in the unchanged binding. Synchronous internal
  handles do not escape into application handlers; release happens after execution/reset. Failed open handles
  are freed by the binding.
- Library configuration reaches all four production open paths. A direct layer probe observed exactly one
  `sqlite-library` event per startup: default path `/usr/lib/x86_64-linux-gnu/libsqlite3.so.0`, version
  `3.45.1`; explicit configured path `/usr/local/lib/libsqlite3.so.0`, version `3.53.4`. No server.ts edit was
  needed because the existing server composition already builds the changed layers.
- Boundary exemptions are exact paths, and stale entries fail. In a scratch archive under `agent-work/`,
  injecting `import "node:sqlite"` separately into server.ts and reader.ts made the graph test fail with the
  respective entrypoint named. Removing the driver mention from the exempted sqlite_ffi/mod.ts made the
  stale-entry test fail. Original tracked code stayed unchanged. These guards work, but cannot validate the
  file isolation promised by an exemption.
- All 26 implementation paths are in the brief’s file list or the coordinator’s three accepted comment-only
  additions; finding 2 records the one edit-kind exception. The separate knowledge and brief commits are
  assessed separately from the implementation ownership audit.

Validation run by this reviewer, with suites sequential (no overlapping tenants suites):

| Check                                      | Result                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `deno task lint`                           | PASS, 162 files                                                                                        |
| `deno task check`                          | PASS                                                                                                   |
| `deno fmt --check` on all 28 changed files | 27 pass; brief.md fails (finding 3); all 26 implementation files pass                                  |
| `deno task test`                           | PASS, 668 passed / 0 failed / 1 ignored (5m36s)                                                        |
| `deno task test:prop`                      | PASS, 79 passed / 0 failed (3m1s)                                                                      |
| `deno task integration`                    | PASS: both layouts, read-after-write, aggregation, isolation, backup/restore, HTTP auth and log ingest |
| Server and reader graph injection probes   | Both fail as expected                                                                                  |
| Stale allow-list probe                     | Fails as expected                                                                                      |
| Same-file oracle lifetime probe            | Both layouts fail as described in finding 1                                                            |
| Startup library-event probe                | PASS, default and explicit library                                                                     |

The builder records E2E 7/7, stress 29 passes plus one known cancellation-timing failure in 30 runs with zero
crashes, and six interleaved perf runs per revision (p50 12.40 → 11.07 ms; p99 141.78 → 69.97 ms). Those are
builder evidence from the implementation commit, not independently repeated reviewer results. Repository-wide
fmt remains outside this review’s green claim because of the documented unowned decisions.md baseline failure.

Learning and handoff: the coordinator must authorize repair of the oracle’s live-file regression and record
the test-double scope variance. Preserve the durable lesson in project knowledge: an exact-path exemption is
not proof of driver/file isolation; trace every open and its scope, including tests that mix raw SQL and
scoped Storage. This report commits that handoff within my ownership; I did not edit docs/knowledge or add
reusable scripts. The review worktree remains available for coordinator inspection and subsequent cleanup. No
merge or main push was performed.
