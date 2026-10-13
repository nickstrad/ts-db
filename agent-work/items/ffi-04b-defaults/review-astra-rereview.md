# FFI-04b re-review

Reviewer: Codex Astra, actor `astra-ffi-04b-rereview`. Reviewed `f935144` (code fixup `eac9c42`), delta
`f01425f..f935144`, with the whole item `51a5283..f935144` for context. Review only; no product edits.

## Verdict: NITS

Both original code nits are closed. No functional defect found. One formatting nit remains in the new brief
note; it is separate from the known baseline formatting problem in `docs/knowledge/decisions.md`.

## Defects

1. **`agent-work/items/ffi-04b-defaults/brief.md:61` — the added fixup note is not formatted.** Lines 61–66
   require reflow. Reproduce with `deno fmt --check agent-work/items/ffi-04b-defaults/brief.md`: exit 1,
   `Found 1 not formatted file in 1 file`. The requested six-file delta format check likewise fails on only
   this file; the other five files pass. This makes the fixup's touched-file formatting claim incomplete and
   misses an explicit acceptance check. Formatting this owned Markdown file closes the nit; no runtime
   behavior is affected. This reviewer did not fix it.

## Original nit 1: closed

- `library.ts:105–108` refuses exactly `darwin/aarch64`. `loadLibrary:118–132` checks before both the cache
  lookup and `Deno.dlopen`; neither an explicit path nor a cached library bypasses it.
- `SqliteLibraryError` with existing reason `load-failed`, candidates and an explanatory detail is a
  reasonable representation without expanding the error taxonomy. Symbol-table comment, README and dated
  gotchas entry accurately explain the Apple refusal and fixed-signature limitation.
- Apple's ABI puts anonymous variadic arguments on the stack, unlike this fixed signature. See
  [Apple's ARM64 calling convention](https://developer.apple.com/documentation/xcode/writing-arm64-code-for-apple-platforms).
- **Windows/aarch64 does not share that failure for this signature.** Microsoft's standard ARM64 variadic ABI
  allocates argument slots and puts the first eight slots in x0–x7. Thus this pointer/int/int/pointer call
  uses x0/w1/w2/x3 under both fixed and variadic conventions. This is an ABI inference from
  [Microsoft's parameter-passing and variadic rules](https://learn.microsoft.com/en-us/cpp/build/arm64-windows-abi-conventions?view=msvc-170#addendum-variadic-functions),
  not a Windows execution test. ARM64EC is a distinct ABI with additional requirements, not evidence that
  standard Windows ARM64 is stack-only; this binding does not advertise an ARM64EC target. The default search
  list contains Linux and Darwin paths, no Windows DLL. No additional platform refusal defect is established
  for the listed targets.
- The new pure predicate test checks Darwin arm64 refusal and Linux x86_64/arm64, Darwin x86_64 and Windows
  x86_64 acceptance, plus the host's actual `Deno.build`. It never monkeypatches the host. Windows arm64 is
  not an explicit matrix row; the code's exact condition and ABI analysis cover the question. Actual Mac
  loader refusal was reviewed by control flow, not executed on this Linux host.

## Original nit 2: closed

- `database.ts:432–443` checks both DQS return codes. On failure it builds `SqliteError` with `op: "open"`,
  primary and extended codes, code name, and text from `sqlite3_errstr(rc)` rather than stale connection
  state.
- `database.ts:446–462` relabels the pragma's native `SqliteError` while copying code, extended code, code
  name, native message and optional SQL. It deliberately creates the relabelled error; that is the error the
  outer cleanup subsequently preserves.
- `database.ts:467–477` marks the connection closed, attempts `sqlite3_close_v2` inside a swallowing try, and
  rethrows exactly the caught value. It does not inspect, annotate or replace that value. No statement or pool
  operation has escaped at this stage.
- The inner `instanceof` is classification of the internally generated error from `exec` on a primitive
  constant SQL string, with no caller parameters, signal hooks or callbacks. It is not the FFI-01 ownership
  mistake: the outer cleanup treats exceptions as opaque, and the existing async caller-error handling still
  uses `failure === ownError`. No caller-controlled exception path was introduced here under the normal,
  unmodified binding API.
- Native initialization failure/cleanup remains source-reviewed, not fault-injected. No claim is made that
  normal passing tests exercised OOM or a throwing native cleanup.

## Whole-item pass

- Both read/write and read-only flags join the same initialization block in `Database.open`. DQS DML and DDL
  are disabled before the foreign-key pragma, extended-result setup and busy timeout. Defaults occur once at
  open, not in prepare/step.
- Re-traced Effect `openDatabase` (`effect.ts:250`), Storage's direct open (`sqlite.ts:313`) and injected
  router callback (`tenants/routing.ts:120`), document reader (`document_reader.ts:115`), backup verifier
  (`backup.ts:99`), and both inspection-helper modes (`tests/helpers/sqlite_inspect.ts:63`). All reach that
  block; no alternative native opener was found in the production graph.
- The six defaults regressions cover rw/ro unknown-column errors, rw/ro foreign-key enablement, DDL DQS
  rejection, and orphan inserts with primary 19/extended 787/code name. Valid quoted identifiers and
  single-quoted literals remain accepted. The foreign-key test first disables the writer's setting to
  establish that the next connection gets its own default.
- `core/compile/dialect.ts`, `ddl.ts`, `select.ts` and `write.ts` use validated identifier quotes,
  single-quoted literals and bound values. Generated SQLite DDL introduces no foreign keys. Existing Postgres
  auth foreign keys are unrelated. No emitted SQL dependency on DQS fallback was found.
- The full item changes only its owned files. `deno.json` and callers are untouched.

## Validation

Commands run by this reviewer with Deno 2.9.5 on Linux x86_64; test suites ran sequentially.

| Command                                          | Result                                        |
| ------------------------------------------------ | --------------------------------------------- |
| `deno task lint`                                 | PASS, 162 files                               |
| `deno task check`                                | PASS, 11 configured roots                     |
| `deno task test`                                 | PASS, 675 passed, 0 failed, 1 ignored (4m28s) |
| `deno task test:prop`                            | PASS, 79 passed, 0 failed (2m34s)             |
| `deno task integration`                          | PASS, exit 0                                  |
| `deno fmt --check` on all six delta files        | NIT: only `brief.md` fails                    |
| `deno fmt --check` on the other five delta files | PASS                                          |
| `git diff --check 51a5283 f935144`               | PASS                                          |

No suite retries, timing flakes or native crashes occurred. Both point-read parity tests passed within the
unit suite. Integration reported PASS for both layouts, DuckDB read-after-write, aggregation, app isolation,
backup, restore, HTTP auth, trace IDs, logs ingestion and error-rate analysis. The repository-wide
formatter/aggregate CI was not run because of the declared unowned baseline failure; the delta formatting
failure above is independently new. Raw local logs are `agent-work/items/ffi-04b-defaults/rereview-*.log` (not
committed).

## Learning and handoff

The Apple ABI/defaults findings are already preserved in the item's dated gotchas entry. The additional
Windows ARM64 distinction and trusted-error classification reasoning are preserved in this committed report;
the coordinator may link them from project knowledge in an authorized docs unit. No reusable script or VM
knowledge finding arose. The coordinator owns the brief-format fixup, landing and any C4 follow-up. Retain
this worktree for coordinator inspection/removal; no other worktree or branch was changed.
