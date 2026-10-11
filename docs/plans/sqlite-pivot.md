# Plan: all-SQLite pivot (remove DuckDB)

Status: approved · Author: nickstrad (with Opus) · Date: 2026-10-11 · Target branch: feature branches
off `main`, one commit per item.

This plan migrates ts-db from SQLite+DuckDB to all-SQLite and deletes the DuckDB path entirely.
Feasibility analysis: `/tmp/sqlite-vs-duckdb.md` on vm-1 (Opus, 2026-10-11). The human's decision:
DuckDB's analytical power is premature for the product; operational simplicity wins.

**No flag, no dual-backend.** The human revised the plan on 2026-10-11: there is no
`READER_BACKEND` flag and no period where two backends coexist. The swap is direct —
the SQLite `Reader` replaces the DuckDB one outright, and the DuckDB code is deleted
in the same change. SP-01's flag (landed `4c42d98`) is reverted as part of SP-02.

---

## 0. Where the code is today

Verified against main at `4c42d98` (2026-10-11; SP-01's `READER_BACKEND` option landed, not yet wired).

| File / area                          | Lines | Role in the pivot                                                                                  |
| ------------------------------------ | ----- | -------------------------------------------------------------------------------------------------- |
| `core/compile/dialect.ts:21`         | —     | `export type Dialect = "sqlite" \| "duckdb"` — the document compiler already emits both dialects   |
| `platform/services.ts:357`           | —     | `Reader` is a `Context.Tag` — the seam the SQLite implementation plugs into                        |
| `platform/config.ts`                 | —     | Item-08 options table; `eventLog.duckdbPath` names the DuckDB event-log file; `readerBackend` row (SP-01, to be reverted) |
| `platform/duckdb.ts`                 | ~470  | `ReaderLive`: opens `:memory:` DuckDB, `ATTACH`es app SQLite `READ_ONLY`, per-app cached instances — **deleted** |
| `platform/reader.ts`                 | —     | Reader child-process entry point — **deleted**                                                     |
| `platform/reader_layers.ts`          | —     | Reader root layer composition (child side) — **deleted**                                           |
| `platform/ipc.ts`                    | ~716  | `ReaderClientLive`: spawn/supervise child, JSON-lines IPC, restart-with-backoff — **deleted**      |
| `core/ipc/framing.ts`                | ~60   | Pure JSON-lines decoder — **deleted**                                                               |
| `platform/eventlog/ingest.ts:19`     | —     | `read_json_auto` — the one DuckDB dependency in the write path                                     |
| `platform/eventlog/tables.ts`        | —     | Event-table DDL (DuckDB dialect)                                                                   |
| `platform/analysis/catalog.ts`       | —     | 24 named SELECTs; **12 `quantile_cont` uses** — the genuine DuckDB lock-in                         |
| `scripts/duckdb/`                    | 9     | Operator SQL scripts (`slowest-sql.sql` also uses a percentile) — ported to `scripts/sql/`         |
| `platform/layers.ts`                 | —     | `ReaderClientConfigured` — becomes a single in-process SQLite `Reader`, no selection, no child     |
| `platform/http/handlers.ts:178,212`  | —     | Query path and ingest path entry points                                                            |
| `docs/adr/0004-eventlog-duckdb-in-reader-only.md` | — | The two-process decision — gets a supersede note                                              |
| `deno.json`                          | —     | Pins `@duckdb/node-api`; test tasks carry `--expose-gc` (for the gc-drain — removed)               |

What each DuckDB dependency costs to replace (from the analysis):
- **Document reads**: already portable — compile with `dialect="sqlite"`, execute in-process.
- **`quantile_cont` (12×)**: no SQLite equivalent — app-level percentile computation in Deno.
- **`::` casts, `$var` params**: mechanical rewrites (`CAST(x AS INTEGER)`, `?`/`:name`).
- **`read_json_auto`**: Deno-side JSONL parsing + batched INSERTs (exactly-once `_ingest_state`
  mechanism ports unchanged).
- **Segfault mitigations** (restart supervision, gc-drain — landed `cd669d1`): become dead code.

---

## SP-01 — `READER_BACKEND` config option — LANDED then REVERTED

- **Status:** Landed as `4c42d98` (Sol build, Astra review PASS). **Reverted by SP-02** —
  the flag has no reason to exist in the no-flag plan. No separate revert item; SP-02
  removes the `readerBackend` row from the item-08 table and the README row.

---

## SP-02 — Direct swap to all-SQLite (absorbs old SP-03/SP-04/SP-05/SP-07)

- **Scoping:** **SYNC. Single item.** The whole swap is one coherent change: in the
  no-flag world the SQLite reader, the ingest port, the catalog port, the concurrency
  cap, and the DuckDB deletion are not separable — the `Reader` contract covers
  query/ingest/analysis together, and deleting the child process requires all three
  to work on SQLite. The old item boundaries were artifacts of the flag plan.
- **Model:** **Opus / astra.** Replacing a load-bearing subsystem (reader, ingest,
  analysis, IPC, supervision, native dep) in one change needs the top tier.
- **Owns:** new `platform/reader_sqlite.ts` (the `Reader` implementation),
  `platform/layers.ts` (single in-process reader; remove `ReaderClientConfigured`
  selection), `platform/services.ts` (only if the `Reader` tag needs extension —
  prefer no change), `platform/config.ts` (revert `readerBackend` row; add
  `sqliteAnalysisConcurrency` row), `platform/eventlog/ingest.ts`,
  `platform/eventlog/tables.ts`, `platform/analysis/catalog.ts`, new
  `core/stats.ts`, `scripts/duckdb/` → `scripts/sql/`, `deno.json`, README.
- **Deletes:** `platform/duckdb.ts`, `platform/reader.ts`, `platform/reader_layers.ts`,
  `platform/ipc.ts`, `core/ipc/framing.ts`.
- **Reads:** `platform/duckdb.ts` (the contract to reimplement), `platform/services.ts:357`,
  current `ingest.ts` (the `_ingest_state` exactly-once mechanism — ports unchanged),
  `platform/analysis/catalog.ts` (the 12 `quantile_cont` sites).
- **Work:**
  1. New SQLite `Reader` implementing the full tag contract (`query`/`ingest`/`analysis`/`ping`)
     in-process via `node:sqlite`. Document queries compile with `dialect="sqlite"`.
     No child process, no IPC.
  2. Ingest: replace `read_json_auto` with Deno-side parsing — the JSONL is already read
     line-by-line for hashing; parse, validate, bind, batched-INSERT inside the existing
     transaction structure. Port `tables.ts` DDL to SQLite (same table/column names).
     Keep `_ingest_state` (byte offsets + sha256) byte-for-byte in behavior: idempotent
     re-ingest, quarantine table for rejected lines (now caught parse errors — more
     debuggable). Rename `eventLog.duckdbPath` to neutral `eventLog.path` with a
     deprecation note in the docs.
  3. Analysis: new `core/stats.ts` with exact `quantileSorted(values, q)`; property test
     against known percentile values on 1000+ randomized inputs. Rewrite the 12
     `quantile_cont` sites (query returns the bounded raw column; percentile computed in
     Deno; output column names identical). Mechanical rewrites: `::BIGINT` →
     `CAST(x AS INTEGER)`, `$var` → `?`/`:name` per the SQLite dialect.
  4. Concurrency cap: `node:sqlite` is synchronous — add a `Semaphore(n)` around
     analytical query execution so one tenant's full-table scan can't starve the event
     loop. New item-08 option `sqliteAnalysisConcurrency`, env
     `SQLITE_ANALYSIS_CONCURRENCY`, default `4`; README row to match. Queue-full → 503
     via the existing `QueueFullError` → 503 mapping.
  5. `platform/layers.ts`: the SQLite reader is the only backend — no selection, no
     `ReaderClient`, no spawn. Remove the `ReaderClientLive` machinery with `ipc.ts`.
  6. Revert SP-01: remove the `readerBackend` row from the item-08 table and README.
  7. Delete the DuckDB path: the files listed above; the `@duckdb/node-api` pin in
     `deno.json`; `--expose-gc` from test tasks; the segfault-mitigation code (restart
     supervision, gc-drain); the 502-on-reader-death mapping (verify other 502 uses
     remain and keep them).
  8. `scripts/duckdb/` → `scripts/sql/`, ported to SQLite.
- **Acceptance criteria:**
  - Zero `@duckdb` imports; `deno.lock` no longer contains the package; no native
    DuckDB binary in the install.
  - One process: server spawns no children (test asserts via process listing).
  - `deno task check` green; full unit + property suite green.
  - Document queries (both storage layouts) return correct results.
  - Ingest ≥ 5k events/sec (item-11 bar; report the measured number); idempotent
    re-ingest inserts nothing; crash mid-batch (kill -9) → re-run → no dupes.
  - Percentiles exact: property test green on 1000+ randomized inputs.
  - 8 concurrent full-scan analytical queries with cap 4: all complete, health checks
    answer during the run; queue-full path returns 503, covered by a test.
  - `grep -ri duckdb` returns only historical mentions (ADR supersede note, docs).

---

## SP-06 — All-SQLite verification gate (revised: no dual-backend)

- **Scoping:** **SYNC. Single item.** There is no second backend to compare against —
  the gate is "everything is green on the swapped tree," not "zero divergences."
- **Model:** **Sonnet / sol.** Run the matrix with judgment; investigate failures as bugs.
- **Owns:** `tests/` harness adjustments (remove any backend parameterization scaffolding
  that assumed two backends), a verification report.
- **Reads:** everything SP-02 built.
- **Work:**
  1. Full suite green on the all-SQLite tree: the 62-step conformance suite, property
     tests, unit tests, and the MT-10 e2e (both seeds). Update any e2e assertions that
     assumed reader-process behavior to the single-process world.
  2. Analysis queries return correct results against real ingested data: run the full
     named catalog against a live server workload (as the reflection pass did) and
     verify non-vacuous results.
  3. Benchmarks (honest record of the tradeoff, no bar to clear): document-query
     p50/p99 latency (in-process SQLite vs the old DuckDB-over-IPC numbers from the
     feasibility analysis), analytical query timings on the lx-02-scale fixture.
  4. Write the report to `docs/architecture/sqlite-swap.md` (what changed, verification
     matrix, benchmark numbers).
- **Acceptance criteria:**
  - Full suite green, same commit; zero failures.
  - Report committed.
  - This item's PASS is the explicit gate for declaring the pivot complete. The
    reviewer states the gate is met.

---

## SP-08 — Docs, ADR, diagrams

- **Scoping:** **CONCURRENT with SP-06** after SP-02 lands. Docs-only; no behavior change.
- **Model:** **Haiku / luna.** Fast, bounded, mechanical.
- **Owns:** `docs/adr/0004-eventlog-duckdb-in-reader-only.md` (supersede note),
  `docs/architecture/` C4 diagrams (remove the reader child process),
  `docs/knowledge/decisions.md` (the pivot decision), root `docs.md`, README.
- **Reads:** SP-02's landed tree.
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
SP-02 (swap) → ┬ SP-06 (verification gate)
               └ SP-08 (docs, concurrent with SP-06)
```

- Every item: dedicated branch/worktree, independent review before landing, per the
  standing protocol. Reviews stay top-tier for Opus/astra-built items.
- SP-06's PASS is the hard gate for declaring the pivot complete: the reviewer
  explicitly states everything is green on the all-SQLite tree.
- If SP-06 finds failures that need large fixes, they become SP-09+ items — the gate
  holds regardless.
- SP-01 is landed history; its flag is reverted inside SP-02, not as a separate item.
