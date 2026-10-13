# FFI-04b review (Claude Opus 5.5, actor `opus-ffi-04b-review`)

Reviewed `item/ffi-04b-defaults` @ `f01425f` (implementation `b6b5378`, base `51a5283`), 2026-10-13.

## Verdict: NITS

The implementation meets every acceptance criterion on the target platform (x86_64 Linux, system `libsqlite3`
3.45.1). The nits below are not blockers for landing; NIT 1 should become a follow-up before anyone runs the
binding on Apple Silicon.

## Checks

1. **FFI declaration.** `library.ts:42` declares `(pointer, i32, i32, pointer) -> i32`. On x86_64 SysV, a
   variadic callee reads integer/pointer `va_arg`s from the same registers (rdi, esi, edx, rcx) as a fixed
   call. `%al` is not set by the fixed-signature trampoline, but modern GCC prologues only `test %al,%al`
   before spilling XMM registers, so a garbage value just costs a few spills. The constants
   `SQLITE_DBCONFIG_DQS_DML = 1013` and `SQLITE_DBCONFIG_DQS_DDL = 1014` match SQLite's `c_dbconfig_defensive`
   reference (`/usr/include/sqlite3.h` is absent on this VM). Passing `null` for `int*` is documented as
   allowed. `MIN_VERSION_NUMBER` 3.37.0 is newer than 3.29.0, where the DQS verbs were added, so the verbs
   always exist. The mutation runs below show that the calls actually take effect.
2. **Initialization order.** `database.ts:429-450`: after a successful `sqlite3_open_v2`, the two checked
   `db_config` calls run, then `PRAGMA foreign_keys=ON`, then extended codes and the busy timeout. The
   read-only flag is set before this block, so read-only opens get the same defaults. On failure, the native
   error is read by `sqliteError` while the handle is still open. Then `c.open = false`, `sqlite3_close_v2`
   runs inside a swallowing `try`, and the original error is rethrown unchanged. No `Database` escapes, no
   statements are registered, and nothing reaches a pool thread, so the handle cannot leak. An empirical probe
   showed that `PRAGMA foreign_keys=ON` does no file I/O. Opens still succeed under another connection's
   `BEGIN EXCLUSIVE` in both rw and ro modes (the later `SELECT` gets `SQLITE_BUSY`, as before), on a
   non-database file (`SQLITE_NOTADB` comes later, as before), with `immutable=1` URIs, and with `:memory:`.
   Running the pragma before the busy timeout therefore changes no open behaviour.
3. **Coverage of open paths, checked against the call graph.** Every production and test-helper open goes
   through `Database.open`: `sqlite_ffi/effect.ts:250` (`openDatabase`), `sqlite.ts:313` (storage; the
   injected `open` comes from `tenants/routing.ts:120`, which is also `Database.open`),
   `document_reader.ts:115` (ro), `backup.ts:99` (verify, ro), and `tests/helpers/sqlite_inspect.ts:63` (ro by
   default, rw with `write`). No other `sqlite3_open*` or `node:sqlite` open exists outside the bench script.
4. **Tests.** I mutation-tested the six new tests in uncommitted edits, then reverted them:
   - Removing both `db_config` calls fails the rw/ro unknown-column tests and the DDL test.
   - Removing the pragma fails the rw/ro `foreign_keys` tests and the orphan test.
   - Keeping only DML fails the DDL test.
   - Keeping only DDL fails both unknown-column tests.

   Each half of the change is pinned. The orphan test asserts code 19, extended code 787 and
   `SQLITE_CONSTRAINT_FOREIGNKEY`. The `foreign_keys` test sets the pragma OFF on the writer first, so the
   test checks the new connection's own default.
5. **Perf.** The defaults run once per `Database.open`. Neither `prepare` nor `step` was touched.
   `sqlite_ffi_perf_test.ts` passed both parity tests inside `deno task test`.
6. **Semantics risk.** `core/compile` double-quotes only identifiers that passed `quote` or `identifier`
   validation (`write.ts`, `select.ts`, `ddl.ts`), and `sqlite.ts:256` uses `"field"` as a real alias. The
   only `REFERENCES` in source is the Postgres auth spike. The unit, property and integration suites are green
   with the defaults on.
7. **Ownership.** `git diff --stat 51a5283 f01425f` touches only the owned files plus
   `agent-work/items/ffi-04b-defaults/{brief.md,validation.md,results.json}`.
8. **Docs.** The `gotchas.md:213` entry and `README.md:15` paragraph are accurate. A grep found no stale DQS
   or foreign-key wording elsewhere in `docs/` or `platform/`. `deno fmt --check` on the touched files checked
   8 files, exit 0.

## Nits

1. **`platform/sqlite_ffi/library.ts:41-42`: the variadic ABI assumption is not stated, and it is false on one
   advertised platform.**
   - What is wrong: `DEFAULT_LIBRARY_PATHS` includes `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` (Apple
     Silicon). Apple's arm64 ABI passes variadic arguments on the stack, not in registers. With this fixed
     signature, `sqlite3_db_config` would `va_arg` its `onoff` and `int*` out of stack garbage.
   - Why it matters: DQS could stay silently on, or SQLite could write 4 bytes through a garbage pointer. That
     is memory unsafety, and it did not exist before this change. Linux aarch64 (standard AAPCS64) and x86_64
     on any OS are fine.
   - Reproduce: by reading the source; no Mac is available here.
   - Suggested follow-up: add an `if (Deno.build.os === "darwin" && Deno.build.arch === "aarch64")` refusal
     (typed `SqliteLibraryError`), or at least name the platform assumption in the comment and in
     `gotchas.md`.
   - Not a blocker: the binding has no documented or CI-tested macOS target, and this review's scope is x86_64
     Linux.
2. **`platform/sqlite_ffi/database.ts:430-449`: the failure path is untested, and its errors would be rough.**
   - Untested: no test reaches close-and-rethrow. With `MIN_VERSION_NUMBER` at 3.37 it can only be reached on
     `SQLITE_NOMEM`, so I accept that the builder verified it by reading the source.
   - Rough errors if it did run:
     - A pragma failure surfaces as `op: "exec"` with `sql: "PRAGMA foreign_keys=ON"`, not `op: "open"`.
     - A non-OK `db_config` return does not set the connection's error state. `sqliteError` would then report
       `sqliteMessage: "not an error"`, because `sqlite3_errmsg` is non-empty, so the `errstr` fallback never
       fires.
   - Cosmetic only, and not reachable on supported libraries.

## Validation (run by this reviewer, sequentially, in `/root/Software/tsdb-work/ffi04b-rev`)

| Command                          | Result                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| `deno task lint`                 | PASS, 162 files                                               |
| `deno task check`                | PASS (exit 0)                                                 |
| `deno task test`                 | 674 passed, 0 failed, 1 ignored (4m56s); no flakes this run   |
| `deno task test:prop`            | 79 passed, 0 failed (2m47s)                                   |
| `deno task integration`          | PASS, both layouts and all harness checks                     |
| Touched-file `deno fmt --check`  | PASS, 8 files                                                 |
| Mutation runs (4, reverted)      | Every mutant killed by at least one new test                  |
| Open-path probe (scratch script) | Exclusive lock rw/ro, NOTADB, immutable URI, memory: all open |
