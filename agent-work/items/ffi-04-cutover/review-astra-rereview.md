# FFI-04 re-review after repair 1

Reviewed `7a5734f` on `item/ffi-04-cutover`, repair delta `73f882f..7a5734f`, and full item delta
`182e85d..7a5734f`. Reviewer: Codex Astra, actor `astra-ffi-04-rereview`, branch
`review/ffi-04-astra-rereview`, 2026-10-13. Review only; no product edits.

**Verdict: PASS.** Defect list: none. All three findings from the first review are closed.

## Closure of the first review's findings

1. **Mixed SQLite copies on the oracle's live file: closed.** The only `DatabaseSync` opens left in
   `tests/property/sqlite_oracle_test.ts` are `:memory:` at lines 226 and 262. Regression 2 now opens its side
   connection with `inspect(file, { write: true })` at line 351. This is the same library, not merely the same
   TypeScript API: `runTest` → `provideTest` supplies `TestLayer` → `ConfigTest()`; `DEFAULT_CONFIG` is built
   from an empty environment and has `sqlite.library === undefined`. `makeSingleStorage` passes that value to
   `Database.open`, while `inspect` omits `libraryPath`. Both therefore call the same module's
   `loadLibrary(undefined)`, which returns the cached library from `DEFAULT_LIBRARY_PATHS`. No config override
   is supplied by either regression. An ambient `SQLITE_LIBRARY` cannot change `ConfigTest`.

   Each preceding `storage.mutation` is yielded to completion: failed insertion has rolled back, and the empty
   read has committed before the side connection opens. There are no forked mutations or in-flight statements.
   The plain side-connection insert runs synchronously in autocommit mode through that same SQLite copy. The
   helper finalizes each statement in `finally`; the regression closes the connection in `finally`, including
   assertion/SQL failures. A failed native open is cleaned up inside the binding.

   Both layouts retain the exact `SchemaError/type-mismatch/s` assertion for the NUL body, the empty result
   proving the earlier valid insert rolled back, and the post-bypass `StorageError/select/t` assertion. The
   replacement `_id === NUL` assertion is correct and meaningful: binding text reads use
   `sqlite3_column_bytes` and decode the full range when the C-string fast path is shorter. A one-byte NUL
   therefore returns `"\u0000"`, not `""`; this checks that the raw stored identifier survives while the
   Storage contract still rejects the row.

2. **Executable edit outside comment-only scope: closed by explicit acceptance.** The brief's “Deviations
   accepted by the coordinator” section records the `storage_test_layer.ts:471` detail-string change, the
   oracle Owns extension, and the three comment-only changes in `platform/services.ts`,
   `platform/registry.ts`, and `platform/reader_layers.ts`. The executable change still agrees with the live
   layer's NUL error detail. The repair changes only its authorized oracle, brief, and knowledge page.

3. **Brief formatting: closed.** Explicit formatting check of the brief and both other repair-delta files
   passes: `Checked 3 files` (exit 0).

The `7a5734f` gotchas addition accurately preserves the failed exemption assumption and the need to trace
actual opens and lifetimes after a shared helper changes drivers. It is formatted and consistent with the
repair. The intended isolation is between SQLite copies; multiple connections through the same copy, as in
this repaired test, are permitted.

## Whole-item audit

All eight remaining `DatabaseSync(` constructor sites were inspected, including the standalone work script:

| File and current lines                         | Open targets and isolation                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `tests/property/sqlite_oracle_test.ts:226,262` | `:memory:` only; live-file regression uses FFI.                                    |
| `tests/property/json_number_test.ts:187`       | `:memory:` only.                                                                   |
| `tests/unit/sqlite_ffi_perf_test.ts:36`        | Fresh temp directory's `node.db`; FFI uses `ffi.db`.                               |
| `tests/unit/sqlite_ffi_effect_test.ts:615,616` | Both node connections use fresh temp `node.db`; the FFI busy test uses `ffi.db`.   |
| `tests/unit/sqlite_ffi_effect_test.ts:808`     | Fresh temp `node.db`; FFI uses `ffi.db`.                                           |
| `work-scripts/deno/ffi-binding-bench.ts:55`    | `node.db`; FFI uses `cancel.db` and `ffi.db`. Not reachable from production roots. |

The fresh-eyes pass found no additional defect in the full cutover:

- Writer, document reader, router and backup verifier use the binding. Production wiring carries
  `Config.sqlite.library` to all four paths and the startup library event. Default-only inspection is safe for
  the current callers; its documented prohibition on mixing with an explicitly configured different library
  remains necessary.
- The writer preserves the semaphore, queue cap, transaction release, NUL probe, pragmas, SQL/transaction
  events and queue-draining close. Cached statements are fetched and used in one synchronous step with array
  binds. Snapshot SQL stays `VACUUM INTO ?`. There are no newly introduced async statement calls or native
  deadlines.
- Document connections remain per call, read-only, with `readBigInts: true`; timeout and error mapping remain.
  Router containment/symlink checks still immediately precede synchronous open, and its short-lived DDL
  connection closes. Backup verification opens the snapshot read-only.
- The FFI-01/03 provenance and cleanup lessons are respected: binding internals remain unchanged, cached
  native handles do not escape to application handlers, and error formatting reads captured error fields
  without claiming ownership or modifying the thrown object. No new caller cleanup hooks are introduced.
- Boundary rules use exact-path import/prose lists with stale-entry checks and runtime graph walks for both
  process roots. Source review confirms why the allow-list alone was insufficient; actual open targets now
  meet the rule.
- The accepted DQS/foreign-key defaults difference remains a separately scoped FFI-04b follow-up. The schema
  compiler emits no foreign keys and validates identifiers. It is not an additional landing defect for this
  cutover; the follow-up should retain the lost compiler-error safety checks.

## Independent validation

Suites ran sequentially; every requested command exited 0. No timing flake or crash occurred.

| Check                                                                                                                      | Result / observed output                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `deno task lint`                                                                                                           | PASS: `Checked 162 files`.                                                                                                        |
| `deno task check`                                                                                                          | PASS; all task entrypoints checked.                                                                                               |
| `deno task test`                                                                                                           | `ok \| 668 passed \| 0 failed \| 1 ignored (4m37s)`                                                                               |
| `deno task test:prop`                                                                                                      | `ok \| 79 passed \| 0 failed (3m9s)`                                                                                              |
| `deno fmt --check agent-work/items/ffi-04-cutover/brief.md docs/knowledge/gotchas.md tests/property/sqlite_oracle_test.ts` | PASS: `Checked 3 files`.                                                                                                          |
| `deno task integration`                                                                                                    | PASS: both layouts, DuckDB read-after-write, aggregation, app isolation, backup, restore, HTTP auth, trace IDs and log ingestion. |
| `git diff --check 182e85d 7a5734f`                                                                                         | PASS; no whitespace errors.                                                                                                       |

The full property output explicitly includes:

```text
oracle regression 2: U+0000 text is rejected before commit, never read back truncated (columns) ... ok (178ms)
oracle regression 2: U+0000 text is rejected before commit, never read back truncated (json) ... ok (84ms)
```

Integration's final output:

```text
PASS: both layouts, DuckDB read-after-write, aggregation, app isolation, backup, restore, HTTP auth, X-Trace-Id in JSONL (32 ids), logs-ingest populates DuckDB (125 lines), error-rate-by-handler handlers
```

Local command logs are retained under `agent-work/items/ffi-04-cutover/rereview-evidence/` for coordinator
inspection; the results above are preserved in this report. E2E, the 30-run stress loop, k6 comparisons and
boundary mutation probes were **not independently repeated** in this re-review. The implementation commit
records E2E 7/7, stress 29 passes plus one known cancellation-timing failure with zero crashes, and six
interleaved perf runs per revision (p50 12.40 → 11.07 ms; p99 141.78 → 69.97 ms). The first review records
successful graph-injection and stale-exemption probes. These remain prior evidence, not new reviewer runs.
Repository-wide `fmt:check`/`ci` were not claimed green or rerun: the documented unowned
`docs/knowledge/decisions.md` formatting failure remains outside this repair.

## Learning and handoff

The durable lesson from the first FAIL is already preserved by `7a5734f`; no additional knowledge or reusable
script change is needed for this review. Keep the planned FFI-04b binding-defaults follow-up. This committed
report preserves the assessment within the review's `agent-work/` ownership. The worktree is retained for
coordinator inspection and cleanup. No merge or push to main was performed.
