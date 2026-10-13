# FFI-04b acceptance evidence

All commands ran sequentially in the assigned worktree on 2026-10-13, with Deno from `$HOME/.deno/bin`. No
retries or timing flakes. Machine-readable exits and counts: [results.json](results.json).

| Command                               | Result                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `deno task test --filter "defaults:"` | 8 passed, 0 failed, 667 filtered (six new regressions plus two existing config tests) |
| `deno task lint`                      | PASS, 162 files                                                                       |
| `deno task check`                     | PASS, all 11 configured roots                                                         |
| `deno task test`                      | 674 passed, 0 failed, 1 ignored (5m12s)                                               |
| `deno task test:prop`                 | 79 passed, 0 failed (3m32s)                                                           |
| `deno task integration`               | PASS, both layouts and all harness checks                                             |
| Touched-file `deno fmt --check`       | PASS                                                                                  |
| `git diff --check`                    | PASS                                                                                  |

Repository-wide `fmt:check` and aggregate `ci` were not run: the brief identifies an existing formatting
failure in unowned `docs/knowledge/decisions.md`. All required component tasks and touched-file formatting
were run. Raw stdout/stderr remains at `/tmp/ffi-04b-validation-5h6e6dru` for local inspection.

Integration output:

```text
PASS: both layouts, DuckDB read-after-write, aggregation, app isolation, backup, restore, HTTP auth, X-Trace-Id in JSONL (32 ids), logs-ingest populates DuckDB (125 lines), error-rate-by-handler handlers
```

The existing `sqlite_ffi_perf_test.ts` passed within the unit suite. Reused sync reads (24,000 per path): FFI
p50 8.174 µs, node:sqlite p50 8.170 µs; nonblocking p50 41.019 µs over 2,000 reads. The defaults run only in
`Database.open`, not per statement.

## Verified open paths

- `Database.open`: the same initialization block handles read-write/create, read-only, memory and URI flags;
  direct read-write and read-only behavior is covered by the new regressions.
- `platform/sqlite_ffi/effect.ts` `openDatabase`: snapshots options, then calls `Database.open`.
- `platform/sqlite.ts` storage: default acquisition calls `Database.open` with the configured library.
- `platform/document_reader.ts`: calls `Database.open` with `readOnly: true` and the configured library.
- `platform/tenants/routing.ts`: the preparation callback opens through `Database.open`.
- `platform/backup.ts`: verification opens read-only through `Database.open`.
- `tests/helpers/sqlite_inspect.ts`: both default read-only and `{ write: true }` call `Database.open`.

These call chains were inspected without edits; the existing unit/property/integration tests exercised the
platform callers. No separate wrapper-specific defaults tests were added.

## Reviewer focus and learning assessment

Start at `Database.open`'s two DQS calls: both must precede SQL, each return code must be checked, native
error text must be captured before close, and a throwing cleanup must preserve the original exception. Then
inspect the fixed variadic FFI signature and both DML/DDL regression cases. Native configuration failure was
inspected by source; no artificial failing-library shim was introduced.

The durable finding is preserved by the dated update to the existing defaults entry in
`docs/knowledge/gotchas.md`, included in the implementation commit. No additional knowledge commit, reusable
script or ownership handoff is needed. The coordinator owns independent review, landing, any C4 follow-up, and
worktree removal after inspection. This unit does not merge.
