# FFI-02 review: config options and library resolution

- Reviewer: Claude Opus 5.5 (independent top-tier review)
- Actor: `opus-review-ffi-02`
- Date: 2026-10-13
- Reviewed SHA: `8218433` (`item/ffi-02-config`, builder `haiku-ffi-02`, Claude Haiku 5.5)
- Base: `main` (`dedef4f`)
- Plan: `docs/plans/ffi-implementation.md` FFI-02 (on the `ffiplan` worktree)

Verdict: NITS

The semantics are correct and in parity with the code. The item can land after a human approves it, with or
without the two test and wording nits below. No file outside the Owns set changed.

## Defects

1. **NITS: `tests/unit/config_test.ts:397-406`. The NaN test does not assert the failure reason.** It checks
   `_tag === "ConfigError"` and `key === "STATEMENT_DEADLINE_MS"` but not `reason`. `Schema.NumberFromString`
   accepts the literal string `"NaN"`, so the value reaches the finiteness check and fails `out-of-range` (I
   confirmed this with a probe). A regression that sent NaN down a different path, for example `malformed`,
   would still pass. The brief asks each test to assert the _right_ failure. The acceptance criterion says
   "non-finite", and only NaN is tested. `Infinity` (also `out-of-range`, probed) is the clearer case. Grace
   is tested only at `0`; negative and `Infinity` values are rejected correctly (probed) but have no test.
   _Fix / verify:_ replace the body with
   `expectConfigError({ STATEMENT_DEADLINE_MS: "NaN" }, "STATEMENT_DEADLINE_MS", "out-of-range")`, add an
   `"Infinity"` case, and optionally add `STATEMENT_INTERRUPT_GRACE_MS: "-1"`. Then run
   `deno test -A tests/unit/config_test.ts`.

2. **NITS: `platform/config.ts:326` (mirrored at `README.md:470`). The deadline description uses a term the
   repo does not have.** "(list, aggregate or user-predicate query)" names a "user-predicate query", which
   appears nowhere else in the repo (`grep -rni "user.predicate"` finds only this row). The plan's classifier
   (§1.1 point 2) says unbounded means "any other `select`, `count`, `countBy`", that is, every read except a
   primary-key equality select. This is the operator-facing description, and the parity test fixes it in the
   README, so it should use the plan's terms. _Fix / verify:_ change it to something like "an unbounded
   statement (any read other than an `_id` equality lookup: list, `count`, `countBy`)" in `OPTIONS`, run
   `deno fmt README.md` after updating the row, and run the README parity test.

## Observations (not defects of this item)

- **A. The `READER_CALL_TIMEOUT_MS` row no longer states its full constraint.** On `main`, any finite value
  above 0 was accepted. Now `READER_CALL_TIMEOUT_MS=5000` or lower fails startup unless
  `STATEMENT_DEADLINE_MS` is also lowered, and the error names `STATEMENT_DEADLINE_MS`/`inconsistent`
  (probed). The plan intends this behaviour, and the new row says "< READER_CALL_TIMEOUT_MS". But the
  `readerCallTimeoutMs` description (`platform/config.ts:298-306`, `README.md:468`) still says only "Must be
  finite and > 0." Owns says "additive rows only", so the builder was right to leave it. FFI-08 (docs) or the
  human should add "and > STATEMENT_DEADLINE_MS".
- **B. FFI-05 should know that `ConfigTest` skips cross-field checks.** This is the existing pattern:
  `ConfigTest` merges overrides without running `assemble`. For example,
  `tests/unit/document_reader_test.ts:332` uses `ConfigTest({ reader: { callTimeoutMs: 50 } })`, which now
  produces `sqlite.statementDeadlineMs = 5000 > 50`. That does no harm today because nothing reads
  `Config.sqlite`. FFI-05 tests that tighten the reader timeout must also set `sqlite.statementDeadlineMs`.

## Acceptance check

| Criterion                                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ownership: diff touches only `README.md`, `platform/config.ts`, `platform/services.ts`, `tests/unit/config_test.ts` | Met (`git diff --name-only main...8218433`)                                                                                                                                                                                                                                                                                                            |
| `config.ts` changes additive only                                                                                   | Met: three `OPTIONS` rows, two validation blocks, the `sqlite` assembly, and the `ConfigOverrides`/`ConfigTest` lines; no existing row changed                                                                                                                                                                                                         |
| `sqliteLibrary`/`SQLITE_LIBRARY`: optional-string, no default, `undefined` when unset or empty                      | Met (default test, `SQLITE_LIBRARY=""` probed to `undefined`); the description names >= 3.37.0, 3.45.1 under `/usr/lib/x86_64-linux-gnu` and 3.53.4 under `/usr/local/lib`, and the binding's default list. "Tries the distro path first" matches `DEFAULT_LIBRARY_PATHS` on `item/ffi-binding`, and `MIN_VERSION_NUMBER = 3_037_000` matches the gate |
| `statementDeadlineMs`: default 5000, finite and > 0, strictly < `readerCallTimeoutMs`, `inconsistent` ConfigError   | Met. Probed: NaN and Infinity give `out-of-range`; "soon" gives `malformed`; 30000/30000 and 40000/default give `inconsistent`; 29999/30000 passes. The description covers the `sqlite3_interrupt`, the typed deadline error and HTTP 504 once FFI-05 lands                                                                                            |
| `statementInterruptGraceMs`: default 1000, finite and > 0                                                           | Met (0, -5 and Infinity give `out-of-range`, probed); the description names the error-level lifecycle event and the poisoned connection                                                                                                                                                                                                                |
| `Config.sqlite: SqliteConfig` assembled like `reader: ReaderConfig`; overrides merge                                | Met (`services.ts` interface and `ConfigService` field; `ConfigOverrides.sqlite` is `Partial<SqliteConfig>`; `ConfigTest` uses the same spread as its neighbours)                                                                                                                                                                                      |
| No `Deno.env` read outside `platform/config.ts`                                                                     | Met (grep over `platform core sdk app`)                                                                                                                                                                                                                                                                                                                |
| Validation style matches neighbouring rows                                                                          | Met: same `configError(envVar, reason, detail)` construction, same "must be finite and > 0, got X" wording as `READER_CALL_TIMEOUT_MS`, and the same `inconsistent` reason as the S3 and TENANCY cross-field checks; `defaultLabel: "(unset)"` matches the other optional-string rows                                                                  |
| README parity with code (names, env vars, types, defaults, descriptions)                                            | Met. The parity test renders every `OPTIONS` row through `renderOptionsTable()` and compares the whole section, so it covers the three new rows                                                                                                                                                                                                        |
| README reflow is formatting-only                                                                                    | Met. `git diff -w` plus a porcelain word diff shows the only non-whitespace changes are the three new rows; the other hunks are `deno fmt` table-separator padding and paragraph rewrapping (lines 45, 146-149, 442, 489-494)                                                                                                                          |
| Tests: defaults, `SQLITE_LIBRARY`, 0, negative, NaN, non-numeric, >= reader timeout, just under it, grace 0         | Present; all but NaN assert key and reason (Defect 1)                                                                                                                                                                                                                                                                                                  |

## Checks run (worktree `/root/Software/tsdb-work/ffi02-review` at `8218433`)

- `deno task lint`: exit 0, 151 files checked.
- `deno task check`: exit 0.
- `deno fmt --check platform/config.ts platform/services.ts README.md tests/unit/config_test.ts`: exit 0, 4
  files checked.
- `deno task fmt:check` (repo-wide): 2 unformatted files, `docs/knowledge/decisions.md` and
  `docs/architecture/README.md`, both pre-existing and outside this item. The `README.md` failure from `main`
  is cleared, as the plan expects.
- `deno test -A tests/unit/config_test.ts`: 35 passed, 0 failed.
- `deno test -A tests/unit/boundaries_test.ts`: 6 passed, 0 failed.
- `deno task test`: 620 passed, 0 failed, 1 ignored (5m20s).
- Edge probe (scratch script, not committed) through `ConfigLive`: NaN and Infinity deadlines, -5 and Infinity
  grace, `READER_CALL_TIMEOUT_MS` of 5000 and NaN, and an empty `SQLITE_LIBRARY`. Results are given above.

## Learning assessment

Haiku 5.5 copied the MT-02/item-08 pattern faithfully, including the cross-field reason and the README parity.
The only slips are a weaker assertion in the one test it wrote by hand instead of with `expectConfigError`,
and one invented term in a description. Expected Haiku-tier quality for a scoped, pattern-copy item.
