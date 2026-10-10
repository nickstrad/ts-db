# C4 Level 2 — Container: the platform's observability path

Terminal rendering, for `glow docs/architecture/c4-container-observability.terminal.md`. The same diagram as
Mermaid, for GitHub: [`c4-container-observability.github.md`](c4-container-observability.github.md).

The request and backup path is the companion Level 2 diagram: `c4-container-platform.terminal.md`.

## What this shows

Where platform events go: the rotating JSONL files both processes append to, the DuckDB file they are
materialised into, the k6 output that joins against them, and the CLI that queries the result.

**Most of this diagram is planned.** The two processes and the k6 results directory exist; the log
directories, the DuckDB event log and the `logs` CLI are plan items 11, 21, 23 and 24 of
`docs/plans/effect-port-and-observability.md`. Today the platform's only observability surface is
`TRACE_SQL=1`, which prints SQL to stderr from `platform/registry.ts:trace` — the event log replaces it.

<!-- c4-render: diagrams/c4-container-observability.py -->

```text
╭╌ Document DB platform - observability path ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮
╎                                                                      ╎
╎  ┌────────────────────────────┐       ┌────────────────────────────┐ ╎
╎  │ Server process             │       │ Reader process             │ ╎
╎  │ [Deno process]             │       │ [Deno child process]       │ ╎
╎  │                            │       │                            │ ╎
╎  │ emits http, sql, tx,       │       │ emits sql, tx and          │ ╎
╎  │ queue, backup and          │       │ ingest events; owns the    │ ╎
╎  │ lifecycle events; runs     │       │ only DuckDB handle, so     │ ╎
╎  │ the retention sweeper      │       │ it also runs the           │ ╎
╎  │ (item 24)                  │       │ event-log ingest           │ ╎
╎  └─────────────┬──────────────┘       └─────────────┬──────────────┘ ╎
╎                │ (1)                                │ (2)            ╎
╎                ▼                                    ▼                ╎
╎  ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┬┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┬┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐ ╎
╎  ┆ JSONL log directories                   [filesystem] (item 11)  ┆ ╎
╎  ┆ logs/<role>/<YYYY-MM-DD>/events-<HH>-<pid>-<seq>.jsonl          ┆ ╎
╎  ┆                                                                 ┆ ╎
╎  ┆ role = server | reader | restore | cli. One JSON object per     ┆ ╎
╎  ┆ line. Rolls on date, hour or 64 MiB. Retention: gzip after 2    ┆ ╎
╎  ┆ days, keep 14 days, 2 GiB cap; today's dir is never swept.      ┆ ╎
╎  └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┬┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘ ╎
╎                                                     │ (3)            ╎
╎                                                     ▼                ╎
╎  ┌────────────────────────────┐       ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┬┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐ ╎
╎  │ k6 results  (item 03;      │       ┆ DuckDB event log           ┆ ╎
╎  │ more in 14) [filesystem]   │       ┆ (item 21) [DuckDB file]    ┆ ╎
╎  │                            │       ┆                            ┆ ╎
╎  │ logs/k6/<run-id>/          ├─(4)──►┆ logs/duckdb/events.duckdb  ┆ ╎
╎  │ raw.json, summary.json     │       ┆ append-only tables plus    ┆ ╎
╎  │ written by the k6          │       ┆ _ingest_state offsets;     ┆ ╎
╎  │ binary, not by Deno        │       ┆ INSERT only                ┆ ╎
╎  └────────────────────────────┘       └┄┄┄┄┄┄┄┄┄┄┄┄┄┬┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘ ╎
╎                                                     ▲ (5)            ╎
╎                                                     │                ╎
╎                                       ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┬┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐ ╎
╎                                       ┆ logs CLI   (item 23)       ┆ ╎
╎                                       ┆ scripts/logs.ts            ┆ ╎
╎                                       ┆                            ┆ ╎
╎                                       ┆ ingest | query | list |    ┆ ╎
╎                                       ┆ sweep. Named analysis      ┆ ╎
╎                                       ┆ queries only - never       ┆ ╎
╎                                       ┆ caller-supplied SQL        ┆ ╎
╎                                       └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘ ╎
╎                                                                      ╎
╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯
```

## Relationships

| # | From                  | To                    | What travels over it                                                                                                                                                                                                                                              |
| - | --------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Server process        | JSONL log directories | One JSON object per line, appended through a dropping `Queue` drained by a background fiber, so logging never blocks or fails a mutation. Drops are themselves logged as a `queue` event. Files roll on date, hour or `maxFileBytes`.                             |
| 2 | Reader process        | JSONL log directories | The same sink in its own `logs/reader/` directory — the pid and sequence in the filename keep two concurrently writing processes from interleaving into one file. **Its stdout stays reserved for the RPC protocol.**                                             |
| 3 | JSONL log directories | DuckDB event log      | Idempotent ingest: DuckDB `read_json_auto` over an explicit file list, trimmed by the byte offsets in `_ingest_state`, inserted into the typed tables and the offsets updated in the **same** transaction. Runs in the reader process, which already owns DuckDB. |
| 4 | k6 results            | DuckDB event log      | (planned, item 25) `perf/ingest_k6.ts` loads `raw.json` into the `k6_points` table with the run id as a column, so the `k6-vs-platform` query can join client-side p95 to server-side handler p95 per 10-second bucket by trace id.                               |
| 5 | logs CLI              | DuckDB event log      | `deno task logs:query <name>` runs an entry from a fixed catalog (`slowest-sql`, `plan-shapes`, `error-rate-by-handler`, `trace`, …). The caller supplies a name and params, never SQL — the same posture as the document API.                                    |

Edge 3 is drawn from the files to the DuckDB log because that is the data flow; the _work_ is done by the
reader process, which is the only container allowed to open DuckDB. Edge 5 points up into the event log
because the CLI reads it.

## The constraint that shapes this diagram

The server process must never open DuckDB (see `c4-container-platform.terminal.md`, "Why there are two
processes"). That rules out "mutations append straight into a DuckDB file" and is why the design has exactly
one durable write path — **rotating JSONL** — with the DuckDB tables as a derived, re-buildable sink ingested
from the process that already owns DuckDB.

Two consequences worth knowing before reading an analysis query:

- **The event log is eventually consistent with the events.** A record is durable once its JSONL line is
  written; it is queryable only after an ingest runs.
- **`_ingest_state` is the only mutable table.** Everything else is INSERT-only, and plan item 26 greps for
  `UPDATE`/`DELETE` outside it. DuckDB event-table pruning is explicitly out of scope for this phase — that
  file grows until a future `logs:compact`.

## Not in this diagram

- **The retention sweeper** is a _component_ of the server process, not a container — it reads the log
  directories and applies the pure policy from `core/logging/rotation.ts`. It appears at Level 3
  (`c4-component-server.terminal.md`).
- **The analysis catalog** (`platform/analysis/catalog.ts`) is likewise a component, reached by the `logs` CLI
  through the reader-side layer stack.
