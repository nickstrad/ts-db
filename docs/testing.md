# Testing

Run from the repository root with a recent Deno 2 runtime. Native service tests need FFI, local npm modules
and the DuckDB sqlite extension; tasks provide permissions. The four tiers describe what a test proves, not
four disjoint directories: historical unit files include real native/process tests.

| Tier                     | What it proves                                                                                                                      | Runner                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Unit on core/            | Pure schema validation, normalization, SQL compilation/decoding, errors, framing and rotation policy                                | `deno task test` includes `tests/unit/` and `tests/core_test.ts`.                                     |
| Property on core/        | Generated schemas/plans/values and invariants, with shrinking and deterministic seeds                                               | `deno task test:prop` includes `tests/property/`; some properties also use real storage as an oracle. |
| Layer-based service      | Storage, Reader, Backups, IPC, logging and HTTP behavior under injected ConfigTest, EventSinkTest, IdGenTest and StorageTest layers | `deno task test`; reusable fixtures live in `tests/layers/`.                                          |
| Real-process integration | Native module separation, HTTP to writer/reader, live reads, backups/restore, logs and tenant isolation                             | `deno task integration` and `deno task e2e`; separately run the k6 observability test below.          |

## Required gate

```sh
deno task ci
```

This runs fmt:check, lint, check, test, test:prop in order. It does not include integration, e2e or the k6
acceptance test. Item 27 executes the gate and both integration commands; dated results are in
[README.md](../README.md). Optional real-S3 backup coverage is ignored without an endpoint and credentials. A
historical native DuckDB exit-139 flake is recorded there; a crashed test process is never a passing run.

## Replaying a property failure

`tests/property/arbitraries.ts` sets 200 runs and the default seed 20261010, prints it in test names, and
appends a replay command to fast-check's counterexample report. Replay the reported seed, for example:

```sh
PROP_SEED=20261010 deno task test:prop
```

Item 27 executes this default-seed replay. Substitute the failing integer, keep the same source/dependency
versions, and preserve the reported counterexample, shrink path and test title. The harness exposes a seed
override, not a shrink-path environment option; replaying the whole seed redoes the original generation and
shrinking. A different seed explores new cases rather than reproducing that failure.

## Storage conformance

`tests/core_test.ts` contains the storage-conformance sequence and applies shared semantic cases to the
in-memory `StorageTest` and real `StorageLive` in both layouts, comparing every result and final contents.
`tests/unit/storage_test.ts` separately exercises real SQLite transactions, rollback, expired contexts,
metadata and serializability. Together these checks keep the double faithful to storage semantics rather than
merely mocking calls. `tests/property/storage_commit_test.ts` supplements this with generated state/commit
behavior. Reader and cross-dialect properties check live-file reads and SQLite/DuckDB agreement; the in-memory
double alone cannot prove native SQL, filesystem, IPC or process cleanup behavior.

## FFI binding properties

Generator-driven invariants for the SQLite FFI binding (`platform/sqlite_ffi/`). The two `tests/property/`
suites run in `deno task test:prop` (the task globs `tests/property/`) and use seed 20261010 unless
`PROP_SEED` is set; the run count is in each test name. The classifier property is a unit test (last row) and
runs in `deno task test`.

| Suite                                  | What it pins                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Runs                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `tests/property/ffi_roundtrip_test.ts` | `bind -> step -> column` of text (U+0000, lone surrogates), int64 (`bigint`), doubles, blobs and NULL equals `node:sqlite` on a separate `:memory:` database. Named differences: U+0000 text comes back whole (ADR 0005), integral doubles bind as INTEGER, `-0` binds as INTEGER 0, `NaN` is NULL in both drivers. Also unsafe-integer and unbindable values.                                                                                                    | 3 properties x 200, plus one edge-value test |
| `tests/property/ffi_interrupt_test.ts` | Interrupt totality: a random statement and a 0-50 ms `timeoutMs` / `AbortSignal` / both / `Effect.timeout` ends in its rows or its promised cancellation, never hangs (a 15 s guard around the whole iteration, recovery probes included, fails the test), and the connection answers the next statement. A close failure or a close that outlives a 1 s grace fails the test; a native step that cannot be stopped is reported and the process killed (SIGKILL). | 200 iterations, 1 test                       |
| `tests/unit/ffi_classify_test.ts`      | The statement classifier property (FFI-05): `bounded <=> (_id eq filter present and no aggregate)` over 2 000 generated `SelectPlan`s, plus writes always bounded. Lives in the unit suite (`deno task test`, not the seeded harness: fast-check picks a fresh seed each run), not duplicated here.                                                                                                                                                               | 2 000 and 500                                |

The oracle never opens the binding's file: the two SQLite copies in one process must not share a file
(`docs/knowledge/gotchas.md`). Sweep one file over seeds, three at a time (keep it off a loaded host):

```sh
bash work-scripts/bash/property-seed-sweep.sh tests/property/ffi_roundtrip_test.ts - 1 200
bash work-scripts/bash/property-seed-sweep.sh tests/property/ffi_interrupt_test.ts - 1 200
```

A seed fixes the generated inputs, so a failing counterexample replays with `PROP_SEED=<n>` for the round-trip
suite and for every input-only failure. It does not fix scheduling: the interrupt suite races a wall-clock
delay against a running statement, so the same inputs can end in rows on one run and in a cancellation on
another, and a failure that depends on timing or host load can recur only under similar load. Its failure
reports therefore carry the iteration's inputs, phase, elapsed time and the load average, and its coverage
line records the load; read them before concluding a seed is "good" or "bad". Exit 139 (the DuckDB teardown
flake) is the other run-to-run intermittent outcome.

## Integration and MT-10 gate

```sh
deno task integration
deno task e2e
```

MT-10 landed green on main at `643b706` (MT-F gate). `e2e` is defined in package.json and is discoverable by
Deno despite not being a deno.json task. It owns an ephemeral Docker Postgres, runs the journaled migrations,
starts server/reader groups with scratch directories and ephemeral ports, and executes seven seeded scenarios:
auth, backup/restore, log analysis, tenant isolation, documents, queries and admin lifecycle. Columns and JSON
fixtures use distinct tenants because each tenant has one schema-guarded file; Better Auth uses a fresh server
per layout to bound login rate-limit interactions. It reports seed/order, seven scenarios and skipped=none,
verifies cleanup and unchanged git status, and fails if its runtime bound is exceeded. Item 27's local results
are recorded in the README.

The item-25 k6 observability acceptance command is:

```sh
deno test -A tests/e2e/observability_test.ts
```

**Not executed in item 27:** it runs k6 and host-dependent load/latency thresholds on this shared 8 GB VM.
Fixture tests of the k6 loader/catalog do not establish a passing performance gate. See
[perf/README.md](../perf/README.md) for methodology and requirements.

## Boundary checks and intended scope

Item 26's `tests/unit/boundaries_test.ts` intentionally applies the console and environment rules only to the
shipped library: `core/`, `platform/`, `sdk/`, `app/`. There, `console.*` is allowed only under
`platform/logging/`, and `Deno.env` only in `platform/config.ts`. Scripts, tests, perf and work-scripts are
outside those two scans because CLI output and test/setup environment access are legitimate there. The
independent item-26 review accepted this scope as sound but weaker than the plan's repository-wide wording;
this documentation records that narrowing explicitly. The separate core import/Deno rule, core/platform
untyped-throw rule and native engine boundary checks keep their own file scopes.
