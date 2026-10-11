# Plan: document reads to in-process SQLite (DuckDB stays for event log + analysis)

Status: approved · Author: nickstrad (with Opus) · Date: 2026-10-11 · Target branch: feature branches
off `main`, one commit per item.

**Narrowed scope (human correction, 2026-10-11):** DuckDB stays for the event log and
analysis queries. Only **document reads** move — from DuckDB (via `ATTACH` in the reader
child) to direct in-process SQLite. The query compiler already emits `dialect="sqlite"`;
the change is to execute that SQL against a `node:sqlite` handle in-process instead of
sending it over IPC.

**What does NOT change:** event-log ingest (stays DuckDB), the analysis catalog
(stays DuckDB, keeps `quantile_cont`), the reader child, IPC, supervision, and the
segfault mitigations — all still load-bearing for ingest + analysis. No
`READER_BACKEND` flag, no backend selection, no DuckDB deletion.

Feasibility analysis: `/tmp/sqlite-vs-duckdb.md` on vm-1 (Opus, 2026-10-11).

---

## 0. Where the code is today

Verified against main at `4c42d98` (2026-10-11; SP-01's `READER_BACKEND` option landed, never wired).

| File / area                         | Role in this plan                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `core/compile/dialect.ts:21`        | `Dialect = "sqlite" \| "duckdb"` — the document compiler already emits `dialect="sqlite"`          |
| `platform/services.ts:357`          | `Reader` is a `Context.Tag` — document reads currently go through it over IPC                       |
| `platform/config.ts`                | Item-08 options table; `readerBackend` row (SP-01, to be reverted — no flag in this plan)            |
| `platform/duckdb.ts`                | `ReaderLive` — **stays** (ingest + analysis still run here)                                         |
| `platform/ipc.ts`, `platform/reader.ts`, `platform/reader_layers.ts`, `core/ipc/framing.ts` | Child + IPC + supervision — **stay** (load-bearing for ingest + analysis)               |
| `platform/http/handlers.ts:178`     | Document query entry point (`kind: "query"`) — rerouted to in-process SQLite                        |
| `platform/http/handlers.ts:212`     | Ingest entry point (`kind: "ingest"`) — **unchanged**, still via reader child                        |
| Analysis catalog                    | **Unchanged** — stays on DuckDB                                                                     |

---

## SP-01 — `READER_BACKEND` config option — LANDED then REVERTED

- **Status:** Landed as `4c42d98` (Sol build, Astra review PASS). **Reverted by SP-02** —
  there is no flag in this plan. No separate revert item.

---

## SP-02 — In-process SQLite document reads

- **Scoping:** **SYNC. Single item.** The whole read-path move.
- **Model:** **Opus / astra.**
- **Owns:** the document-read path (either route `query` inside the `Reader`
  implementation to in-process SQLite, or a new document-read service — builder's
  choice, prefer least invasive), `platform/config.ts` (revert `readerBackend` row),
  README (revert row).
- **Reads:** `platform/duckdb.ts` (current query path), `platform/services.ts:357`,
  `platform/http/handlers.ts:178`, `core/compile/dialect.ts`.
- **Work:**
  1. Open the app's SQLite file directly with `node:sqlite` and run the
     `dialect="sqlite"` compiled document queries in-process. No IPC hop, no child
     process involvement for document queries.
  2. The open must respect the writer: `READ_ONLY`-style access that does not
     interfere with the Storage service's `Semaphore(1)` writer queue (SQLite
     locking + the existing queue already serialize writers; readers must not take
     the writer lock).
  3. Ingest (`kind: "ingest"`), analysis (`kind: "analysis"`), and `ping` keep going
     through the reader child over IPC — untouched.
  4. Revert SP-01: remove the `readerBackend` row from the item-08 table and README.
- **Acceptance criteria:**
  - Document query results identical (both storage layouts) vs the old DuckDB path.
  - No child-process traffic for document queries (test asserts the IPC client is
    not called for `query`).
  - `deno task check` green; unit + property suite green.
  - Ingest and analysis paths verified untouched (existing tests cover them).

---

## SP-05 — Simple concurrency cap for in-process document reads

- **Scoping:** **SYNC, after SP-02.** Small, self-contained.
- **Model:** **Sonnet / sol.**
- **Owns:** the document-read path (semaphore), `platform/config.ts` (only if the cap
  needs tuning — otherwise a well-named constant), `tests/` additions.
- **Reads:** SP-02's read path.
- **Work:**
  1. `node:sqlite` is synchronous. Add a simple `Semaphore` around in-process
     document reads. Document reads are point lookups/small scans, so keep it
     simple — no elaborate queueing machinery.
  2. If the cap should be tunable, add an item-08 option per convention (+ README row);
     otherwise a named constant with a comment. Builder's call, reviewer's check.
- **Acceptance criteria:**
  - Concurrent document reads stay responsive (health checks answer under load).
  - Covered by a test.

---

## SP-06 — Verification gate

- **Scoping:** **SYNC. Single item.** The gate for declaring the change complete.
- **Model:** **Sonnet / sol.**
- **Owns:** verification report.
- **Reads:** everything SP-02/SP-05 built.
- **Work:**
  1. Full suite green on the new document-read path: 62-step conformance suite,
     property tests, unit tests, MT-10 e2e (both seeds).
  2. Event-log ingest and analysis queries verified untouched and green (still
     DuckDB via the reader child — existing tests cover this; call it out explicitly).
  3. Benchmark note: document-query p50/p99 latency in-process SQLite vs the old
     DuckDB-over-IPC path (honest record, no bar to clear).
  4. Write the report to `docs/architecture/sqlite-document-reads.md`.
- **Acceptance criteria:**
  - Full suite green, same commit; zero failures.
  - Report committed.
  - The reviewer explicitly states the gate is met.

---

## SP-08 — Docs

- **Scoping:** **CONCURRENT with SP-06** after SP-02 lands. Docs-only; no behavior change.
- **Model:** **Haiku / luna.** Fast, bounded, mechanical.
- **Owns:** `docs/architecture/` C4 diagrams (document reads now in-process SQLite;
  ingest + analysis still DuckDB-in-reader — no deletion), `docs/knowledge/decisions.md`
  (the narrowed pivot), root `docs.md`, README.
- **Reads:** SP-02's landed tree.
- **Work:**
  1. Diagrams: document-read path updated; reader child remains for ingest/analysis;
     `render.py --check` passes.
  2. `docs.md` + README: describe the in-process document-read path; DuckDB stays for
     event log + analysis (no deletion language).
  3. `docs/knowledge/decisions.md`: record the narrowed pivot and its reason.
- **Acceptance criteria:**
  - `render.py --check` passes; docs describe the landed behavior.
  - Reviewer verifies.

---

## Execution order and gates

```
SP-02 (read-path swap) → SP-05 (cap) → ┬ SP-06 (verification gate)
                                       └ SP-08 (docs, concurrent with SP-06)
```

- Every item: dedicated branch/worktree, independent review before landing, per the
  standing protocol. Reviews stay top-tier for Opus/astra-built items.
- SP-06's PASS is the hard gate for declaring the change complete: the reviewer
  explicitly states everything is green.
- SP-01 is landed history; its flag is reverted inside SP-02, not as a separate item.
