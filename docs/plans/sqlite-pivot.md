# Plan: all-SQLite pivot (remove DuckDB)

Status: proposed · Author: nickstrad (with Opus) · Date: 2026-10-11 · Target branch: feature branches
off `main`, one commit per item.

This plan migrates ts-db from SQLite+DuckDB to all-SQLite and deletes the DuckDB path entirely.
Feasibility analysis: `/tmp/sqlite-vs-duckdb.md` on vm-1 (Opus, 2026-10-11). The human's decision:
DuckDB's analytical power is premature for the product; operational simplicity wins.

**The flag is a temporary migration scaffold, not a permanent dual-backend.** A permanent
`duckdb | sqlite` flag would mean every query tested twice forever, and the portable SQL subset
would rot. The end state is one backend (SQLite) and the DuckDB code deleted. The flag exists
only so the SQLite backend can be built, parity-proven, and then the DuckDB path removed.

---

## 0. Where the code is today

Verified against main at `cd669d1` (2026-10-11).

| File / area                          | Lines | Role in the pivot                                                                                  |
| ------------------------------------ | ----- | -------------------------------------------------------------------------------------------------- |
| `core/compile/dialect.ts:21`         | —     | `export type Dialect = "sqlite" \| "duckdb"` — the document compiler already emits both dialects   |
| `platform/services.ts:357`           | —     | `Reader` is a `Context.Tag` — the seam the flag plugs into                                        |
| `platform/config.ts`                 | —     | Item-08 options table; `eventLog.duckdbPath` (line ~553) names the DuckDB event-log file            |
| `platform/duckdb.ts`                 | ~470  | `ReaderLive`: opens `:memory:` DuckDB, `ATTACH`es app SQLite `READ_ONLY`, per-app cached instances  |
| `platform/reader.ts`                 | —     | Reader child-process entry point                                                                   |
| `platform/reader_layers.ts`          | —     | Reader root layer composition (child side)                                                         |
| `platform/ipc.ts`                    | ~716  | `ReaderClientLive`: spawn/supervise child, JSON-lines IPC, restart-with-backoff (segfault work)     |
| `core/ipc/framing.ts`                | ~60   | Pure JSON-lines decoder (becomes dead code)                                                        |
| `platform/eventlog/ingest.ts:19`     | —     | `read_json_auto` — the one DuckDB dependency in the write path                                     |
| `platform/eventlog/tables.ts`        | —     | Event-table DDL (DuckDB dialect)                                                                   |
| `platform/analysis/catalog.ts`       | —     | 24 named SELECTs; **12 `quantile_cont` uses** — the genuine DuckDB lock-in                         |
| `scripts/duckdb/`                    | 9     | Operator SQL scripts (`slowest-sql.sql` also uses a percentile)                                    |
| `platform/layers.ts`                 | —     | `ReaderClientConfigured` — backend selection goes here                                             |
| `platform/http/handlers.ts:178,212`  | —     | Query path (`kind: "query"`) and ingest path (`kind: "ingest"`) entry points                        |
| `docs/adr/0004-eventlog-duckdb-in-reader-only.md` | — | The two-process decision — gets a supersede note                                              |
| `deno.json`                          | —     | Pins `@duckdb/node-api`; test tasks carry `--expose-gc` (for the gc-drain, SP-07 removes it)       |

What each DuckDB dependency costs to replace (from the analysis):
- **Document reads**: already portable — compile with `dialect="sqlite"`, execute in-process.
- **`quantile_cont` (12×)**: no SQLite equivalent — app-level percentile computation in Deno.
- **`::` casts, `$var` params**: mechanical rewrites (`CAST(x AS INTEGER)`, `?`/`:name`).
- **`read_json_auto`**: Deno-side JSONL parsing + batched INSERTs (exactly-once `_ingest_state`
  mechanism ports unchanged).
- **Segfault mitigations** (restart supervision, gc-drain — landed `cd669d1`): become dead code.

---

## Batch A — scaffold and SQLite backend (SP-01 → SP-02, then SP-03/SP-04/SP-05 in parallel)

#### SP-01 — `READER_BACKEND` config option (item-08 table)

- **Scoping:** **SYNC. Single item.** Everything else keys off this option.
- **Model:** **Sonnet / sol.** Mechanical configuration with an exactly specified target.
- **Owns:** `platform/config.ts`, README "Configuration" section.
- **Reads:** the item-08 options table.
- **Work:**
  1. Add one row to the item-08 options table: name `readerBackend`, env `READER_BACKEND`,
     type `"duckdb" | "sqlite"`, default `"duckdb"`, description noting it is a temporary
     migration scaffold (see this plan's preamble).
  2. README "Configuration" section gains the matching row (reviewer verifies table == docs).
- **Acceptance criteria:**
  - `READER_BACKEND=sqlite` and `READER_BACKEND=duckdb` both decode; anything else is a
    config error at startup.
  - README row matches the table exactly.

#### SP-02 — `ReaderSqliteLive`: in-process SQLite reader backend

- **Scoping:** **SYNC. Single item in its batch.** The core seam; everything downstream
  builds on it.
- **Model:** **Opus / astra.** This is where the pivot either pays off or does not: the
  `Reader` tag contract, in-process SQLite lifecycle, per-app file handling, and the
  backend selection in the layer graph.
- **Owns:** new `platform/reader_sqlite.ts`, `platform/layers.ts` (backend selection),
  `platform/services.ts` (only if the `Reader` tag needs extension — prefer no change).
- **Reads:** `platform/duckdb.ts` (the contract to reimplement), `platform/services.ts:357`.
- **Work:**
  1. New `ReaderSqliteLive` implementing the `Reader` tag: opens the app's SQLite file
     directly with `node:sqlite`, compiles document queries with `dialect="sqlite"`,
     serves `query`/`ingest`/`analysis`/`ping` in-process. No child process, no IPC.
  2. `platform/layers.ts`: select `ReaderLive` (DuckDB) vs `ReaderSqliteLive` on
     `Config.readerBackend`. In SQLite mode nothing spawns — verify with a test that no
     child process exists.
  3. `ReaderClient` in SQLite mode becomes a direct in-process call (no IPC hop);
     the 502 mapping stays for the DuckDB backend only.
- **Acceptance criteria:**
  - `deno task check` and `deno task test` pass.
  - With `READER_BACKEND=sqlite`: document queries (both storage layouts) return identical
    results to DuckDB mode; **no child process is spawned** (assert via process listing
    in the test).
  - With `READER_BACKEND=duckdb` (default): behavior unchanged — existing suite green.

#### SP-03 — Event-log ingest on SQLite (Deno-side JSONL parsing)

- **Scoping:** **CONCURRENT with SP-04/SP-05** after SP-02 lands. Touches only the eventlog
  package.
- **Model:** **Sonnet / sol.** Mechanical port with an exactly specified target and a
  throughput bar to clear.
- **Owns:** `platform/eventlog/ingest.ts`, `platform/eventlog/tables.ts`
  (SQLite DDL for the event tables), `tests/` ingest tests.
- **Reads:** current `ingest.ts` (the `_ingest_state` exactly-once mechanism — ports unchanged).
- **Work:**
  1. Replace `read_json_auto` with Deno-side parsing: the JSONL is already read line-by-line
     for hashing — parse, validate, bind, and batched-INSERT inside the existing transaction
     structure.
  2. Port `tables.ts` DDL to SQLite (types, indexes). Keep table and column names identical
     so the analysis catalog needs no rename churn.
  3. Keep `_ingest_state` (byte offsets + sha256) byte-for-byte in behavior: idempotent
     re-ingest, quarantine for rejected lines (a rejected line is now a caught parse error,
     which is more debuggable — keep the quarantine table).
  4. Event-log file config: `eventLog.duckdbPath` gains a SQLite sibling (or rename to a
     neutral `eventLog.path`; prefer the rename with a deprecation note in the docs).
- **Acceptance criteria:**
  - Ingest benchmark ≥ 5k events/sec (the item-11 bar); report the measured number.
  - Idempotency: second run over an unchanged log tree inserts nothing.
  - Exactly-once preserved under a crash mid-batch (kill -9 the ingester, re-run, no dupes).
  - `deno task test` green in both backend modes.

#### SP-04 — Analysis catalog port: percentiles + SQL rewrites

- **Scoping:** **CONCURRENT with SP-03/SP-05** after SP-02 lands. Touches only the analysis
  package plus one new core helper.
- **Model:** **Sonnet / sol.** Mechanical rewrites plus one small algorithm (percentile) that
  needs property tests proving it matches `quantile_cont`.
- **Owns:** `platform/analysis/catalog.ts`, new `core/stats.ts` (percentile helper),
  `scripts/duckdb/` (port or re-home the operator scripts), `tests/property/` additions.
- **Reads:** `platform/analysis/catalog.ts` (the 12 `quantile_cont` sites).
- **Work:**
  1. New `core/stats.ts`: exact percentile computation over a sorted column
     (`quantileSorted(values, q)`). Property test: matches DuckDB `quantile_cont` on
     randomized inputs (run both engines on the same fixture during the dual-backend
     window — SP-06 keeps the proof).
  2. Rewrite the 12 `quantile_cont` sites: query returns the raw column (bounded — these
     are already grouped/aggregated), percentile computed in Deno via `core/stats.ts`.
     Keep the output column names identical so API consumers see no change.
  3. Mechanical rewrites across the catalog: `::BIGINT` → `CAST(x AS INTEGER)`,
     `$var` → `?`/`:name` per the compiler's SQLite dialect.
  4. `scripts/duckdb/`: port the operator scripts to SQLite (rename dir to
     `scripts/sql/` only at SP-07 deletion time; during the scaffold keep both runnable).
- **Acceptance criteria:**
  - Every named analysis query returns identical results on SQLite vs DuckDB on the same
    fixture (percentiles exact, not approximate).
  - Property test: `quantileSorted` agrees with `quantile_cont` on 1000+ randomized inputs.
  - `deno task test` green in both backend modes.

#### SP-05 — Concurrency cap for in-process analytical queries

- **Scoping:** **CONCURRENT with SP-03/SP-04** after SP-02 lands. Small, self-contained.
- **Model:** **Sonnet / sol.** Small state machine with an obvious contract.
- **Owns:** `platform/reader_sqlite.ts` (the semaphore), `platform/config.ts` (one new
  item-08 row), `tests/` additions.
- **Reads:** SP-02's `ReaderSqliteLive`.
- **Work:**
  1. `node:sqlite` is synchronous — a long analytical scan blocks the event loop. Add a
     `Semaphore(n)` around analytical query execution in `ReaderSqliteLive` so one
     tenant's full-table scan can't starve everything else.
  2. New item-08 option: `sqliteAnalysisConcurrency`, env
     `SQLITE_ANALYSIS_CONCURRENCY`, default `4`. README row to match.
  3. Overload behavior: beyond the cap, queue bounded; queue-full → 503 (reuse the
     existing `QueueFullError` → 503 mapping).
- **Acceptance criteria:**
  - 8 concurrent full-scan analytical queries with cap 4: all complete, event loop stays
    responsive (health checks answer during the run).
  - Queue-full path returns 503, covered by a test.

---

## Batch B — parity proof (SP-06, gated on Batch A)

#### SP-06 — Dual-backend parity run

- **Scoping:** **SYNC. Single item.** The gate for deletion — nothing in Batch C starts
  until this is green.
- **Model:** **Sonnet / sol.** Run the matrix, investigate divergences with judgment;
  every divergence is a P1 bug filed as a new item, not a known difference.
- **Owns:** `tests/` harness (backend parameterization), a parity report.
- **Reads:** everything Batch A built.
- **Work:**
  1. Parameterize the suite on `READER_BACKEND`: the 62-step conformance suite, property
     tests, unit tests, and the MT-10 e2e (both seeds) each run twice — once per backend.
  2. Investigate every divergence. Divergences are bugs; fix them in place (small) or file
     a new SP item (large). "Known differences" are not accepted.
  3. Benchmark: document-query p50/p99 latency SQLite-in-process vs DuckDB-over-IPC;
     analytical query timings on the lx-02-scale fixture (report both, no bar to clear —
     this is the honest record of what the pivot trades).
  4. Write the parity report to `docs/architecture/sqlite-parity.md` (matrix, numbers,
     divergences found and fixed).
- **Acceptance criteria:**
  - Full suite green on **both** backends, same commit.
  - Parity report committed; zero open divergences.
  - This item's PASS is the explicit gate for SP-07. The reviewer states the gate is met.

---

## Batch C — deletion (SP-07, gated on SP-06; SP-08 alongside)

#### SP-07 — Delete the DuckDB path

- **Scoping:** **SYNC. Single item.** High blast radius, one careful commit.
  **Gated on SP-06's parity PASS — do not start early.**
- **Model:** **Opus / astra.** Deleting a load-bearing subsystem (child process, IPC,
  supervision, native dep) needs the top tier; a missed reference breaks the build in
  ways tests may not catch until e2e.
- **Owns:** `platform/duckdb.ts` (delete), `platform/reader.ts` (delete),
  `platform/reader_layers.ts` (delete or fold), `platform/ipc.ts` (delete — the whole
  `ReaderClientLive` child-supervision machinery), `core/ipc/framing.ts` (delete),
  `platform/layers.ts` (remove backend selection; `ReaderSqliteLive` becomes `ReaderLive`),
  `platform/eventlog/ingest.ts` (remove DuckDB branch), `deno.json` (remove
  `@duckdb/node-api` pin; remove `--expose-gc` from test tasks), `scripts/duckdb/`
  → `scripts/sql/`, `platform/config.ts` (remove `READER_BACKEND` — the scaffold is
  struck; optionally remove `eventLog.duckdbPath` rename leftovers).
- **Reads:** the SP-06 parity report (proof the DuckDB path is unneeded).
- **Work:**
  1. Delete the files above; remove the backend selection (SQLite is the only backend).
  2. Remove the `READER_BACKEND` option from the item-08 table and README (scaffold struck).
  3. Remove the segfault-migration code that is now dead: restart supervision, gc-drain,
     `--expose-gc` flags, the 502-on-reader-death mapping (keep 502 for its other uses
     if any — verify).
  4. `deno task ci` fully green; `grep -ri duckdb` across the repo returns only
     historical mentions (ADR supersede note, parity report, changelog).
  5. Verify the deployment footprint: no native DuckDB binary in the install.
- **Acceptance criteria:**
  - Zero `@duckdb` imports; `deno.lock` no longer contains the package.
  - One process: server spawns no children (e2e asserts this).
  - Full suite green; MT-10 e2e green (it previously asserted reader-process behavior —
    update those assertions to the single-process world).
  - The binary installs without the ~50MB DuckDB native module.

#### SP-08 — Docs, ADR, diagrams

- **Scoping:** **CONCURRENT with SP-07.** Docs-only; no behavior change.
- **Model:** **Haiku / luna.** Fast, bounded, mechanical.
- **Owns:** `docs/adr/0004-eventlog-duckdb-in-reader-only.md` (supersede note),
  `docs/architecture/` C4 diagrams (remove the reader child process),
  `docs/knowledge/decisions.md` (the pivot decision), root `docs.md`, README.
- **Reads:** SP-07's final tree.
- **Work:**
  1. ADR 0004: supersede note — the two-process split existed for DuckDB's SQLite copy;
     with DuckDB gone the constraint inverts (one SQLite in the address space; in-process
     reads are safe under the Storage `Semaphore(1)` + SQLite locking).
  2. C4 diagrams: single-process architecture; `render.py --check` passes.
  3. `docs.md` + README: remove DuckDB mentions, reader-supervision runbook entries,
     and the 502-on-reader-crash semantics; document the analytical-query concurrency cap.
  4. `docs/knowledge/decisions.md`: record the pivot and its reason (premature
     analytical scale; simpler systems survive).
- **Acceptance criteria:**
  - `render.py --check` passes; no stale DuckDB references in user-facing docs.
  - Reviewer verifies docs describe the landed single-process behavior.

---

## Execution order and gates

```
SP-01 → SP-02 → ┬ SP-03
                ├ SP-04   (concurrent)
                └ SP-05
                      → SP-06 (PARITY GATE) → SP-07 + SP-08 (concurrent)
```

- Every item: dedicated branch/worktree, independent review before landing, per the
  standing protocol. Reviews stay top-tier for Opus/astra-built items.
- SP-06's PASS is a hard gate: SP-07 does not start until the reviewer explicitly states
  parity is proven.
- If SP-06 finds divergences that need large fixes, they become SP-09+ items between
  SP-06 and SP-07 — the gate holds regardless.
