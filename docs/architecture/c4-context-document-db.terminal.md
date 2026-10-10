# C4 Level 1 — System Context: the Document DB platform

Terminal rendering, for `glow docs/architecture/c4-context-document-db.terminal.md`. The same diagram as
Mermaid, for GitHub: [`c4-context-document-db.github.md`](c4-context-document-db.github.md).

## What this shows

The platform as a single box, the people who use it, and the systems outside it. Everything inside the box is
expanded at Level 2 (`c4-container-platform.terminal.md`).

Dashed boxes labelled `planned` do not exist on `main` yet; they come from
`docs/plans/effect-port-and-observability.md`. Solid boxes are built today.

<!-- c4-render: diagrams/c4-context-document-db.py -->

```text
┌────────────────────┐  ┌────────────────────┐  ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
│ App developer      │  │ Player             │  ┆ Platform operator  ┆
│ [Person]           │  │ [Person]           │  ┆ [Person] (planned) ┆
│                    │  │                    │  ┆                    ┆
│ declares a schema  │  │ plays tic-tac-toe  │  ┆ triggers backups;  ┆
│ and the handlers   │  │ via the sample app │  ┆ runs named log     ┆
│ in app/; runs it   │  │ or the CLI demo    │  ┆ analysis queries   ┆
└──────────┬─────────┘  └──────────┬─────────┘  └┄┄┄┄┄┄┄┄┄┄┬┄┄┄┄┄┄┄┄┄┘
           │ (1)                   │ (2)                   │ (3)
           ▼                       ▼                       ▼
┌──────────┬───────────────────────┬───────────────────────┬─────────┐
│ Document DB platform                            [this system]      │
│                                                                    │
│ Deno + TypeScript document database. An app declares a schema      │
│ and named handlers; the platform compiles document operations      │
│ to SQLite SQL for writes and DuckDB SQL for reads. A caller        │
│ sends a handler name and JSON args - never SQL.                    │
└──────────┬───────────────────────┬───────────────────────┬─────────┘
           │ (4)                   │ (5)                   ▲ (6)
           ▼                       ▼                       │
┌──────────┬─────────┐  ┌┄┄┄┄┄┄┄┄┄┄┬┄┄┄┄┄┄┄┄┄┐  ┌──────────┬─────────┐
│ S3-compatible      │  ┆ DuckDB analytics   ┆  │ k6 load generator  │
│ object storage     │  ┆ consumer           ┆  │ [External system]  │
│ [External system]  │  ┆ [External] planned ┆  │                    │
│                    │  ┆                    ┆  │ k6 v0.56.0; smoke, │
│ immutable snapshot │  ┆ any DuckDB client  ┆  │ mutation, query,   │
│ + manifest objects │  ┆ on eventlog.duckdb ┆  │ mixed (03 and 14)  │
└────────────────────┘  └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘  └────────────────────┘
```

## Relationships

| # | From                        | To                                  | What travels over it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| - | --------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | App developer               | Document DB platform                | Declares the schema in `app/schema.ts` and the handlers in `app/functions.ts`, then runs `deno task serve`. Handlers are statically registered modules — there is no code upload path.                                                                                                                                                                                                                                                                                                                                                        |
| 2 | Player                      | Document DB platform                | `POST /apps/<appId>/<query\|mutation>/<name>` with a JSON argument object and a per-app bearer token. Body cap 64 KiB. Never SQL.                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3 | Platform operator (planned) | Document DB platform                | `POST /admin/backup/<appId>` with the admin token today; `POST /admin/logs/ingest` and `deno task logs:query <name>` once items 21–23 land.                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4 | Document DB platform        | S3-compatible object storage        | `VACUUM INTO` snapshot → `PRAGMA quick_check` → SHA-256 → PUT the snapshot, PUT its manifest, and only then PUT `apps/<appId>/latest.json`. `scripts/restore.ts` reads the same objects back.                                                                                                                                                                                                                                                                                                                                                 |
| 5 | Document DB platform        | DuckDB analytics consumer (planned) | The reader process ingests the rotating JSONL event log into the persistent DuckDB file named by `EVENTLOG_DUCKDB` (default `<DATA_DIR>/eventlog.duckdb`, fixed by `platform/config.ts` in item 08; the plan's §4.1 layout still says `logs/duckdb/events.duckdb`, which item 21 reconciles); any DuckDB client can then read those append-only tables. The starter `.sql` files in `scripts/duckdb/` are written against that schema; only `log-level-distribution.sql`, which reads the JSONL files directly, can run before item 21 lands. |
| 6 | k6 load generator           | Document DB platform                | Load scenarios against the same HTTP API. The k6 binary and `perf/smoke.js` landed with plan item 03; the mutation/query/mixed scenarios landed with item 14. The `X-Trace-Id` header is sent per iteration (`${__VU}-${__ITER}-${runId}`, via `perf/lib/api.js`); joining client-side latency to server-side event durations is planned in item 25.                                                                                                                                                                                          |

Edge 6 points **into** the platform, which is why its arrowhead sits against the platform box.

## Notes on scope

- **The two demo apps are one deployment.** `tic-tac-toe` and `tic-tac-toe-json` run the same application code
  against independent database files; they are not separate systems and are not a tenant-isolation boundary.
- **There is no authenticated end-user identity.** The Player actor reaches the platform through an app-level
  shared bearer token; `playerId` is supplied by the caller, not verified. Row-level authorisation does not
  exist.
- **The local `./object-store/` directory is the default stand-in** for the S3 external system, so the whole
  snapshot/restore flow runs without a cloud account. It is not off-host redundancy.
- **Backup is asynchronous.** A successful mutation acknowledges a local SQLite commit, not S3 durability;
  losing the host loses commits newer than the last completed snapshot.
