# C4 Level 2 — Container: the platform's request and backup path

Renderings: [GitHub](c4-container-platform.github.md) · [terminal](c4-container-platform.terminal.md).

The platform's logging and analysis containers are a second Level 2 diagram, so neither picture is cluttered:
[`c4-container-observability.github.md`](c4-container-observability.github.md).

## What this shows

The request path across the caller-side SDK, two platform OS processes, app database files and the external
object store. Inside the server process is expanded at [Level 3](c4-component-server.github.md).

The server mounts `PlatformLive` from `platform/layers.ts` (item 22) under `makeServer` (item 32).
`AppServicesLive` owns one `StorageLive` and one `BackupsLive` per registered app. The reader is a scoped
Effect program (item 16) with its own composition root, `platform/reader_layers.ts` (item 33), reached through
`ReaderClientLive` (item 17). Its pool lazily opens a separate in-memory DuckDB instance and connection per
app. All requests, queries and ingest alike, run sequentially in the child. The server treats the child as
load-bearing: if it exits while the server is serving, the server shuts down in order and exits 1. The
reader's event-log composition is shown in the [observability diagram](c4-container-observability.github.md).

The SDK is shown outside the host boundary because it runs in the caller's process.

<!-- c4-render: diagrams/c4-container-platform.py -->

```text
   ┌────────────────────────────┐
   │ Typed client SDK           │
   │ [library, caller process]  │
   │                            │
   │ sdk/client.ts (item 10) +  │
   │ an import type of the      │
   │ app's handler map. Sends a │
   │ name + X-Trace-Id, no SQL. │
   └─────────────┬──────────────┘
                 │ (1)
╭╌ Platform host ┬╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮
╎                │                                                     ╎
╎                ▼                                                     ╎
╎  ┌────────────────────────────┐       ┌────────────────────────────┐ ╎
╎  │ Server process             │       │ Reader process             │ ╎
╎  │ [Deno process] :8000       │       │ [Deno child process]       │ ╎
╎  │                            ├─(2)──►│                            │ ╎
╎  │ platform/server.ts         │       │ platform/reader.ts         │ ╎
╎  │ HTTP API, auth, mutation   │       │ query handlers + DuckDB,   │ ╎
╎  │ handlers, SQLite writer    │       │ event-log ingest. Root:    │ ╎
╎  │ per app, backup fiber,     │       │ reader_layers.ts (33).     │ ╎
╎  │ ingest timer. No DuckDB.   │       │ Never imports node:sqlite. │ ╎
╎  └──┬──────────┬──────────────┘       └─────────────┬──────────────┘ ╎
╎     │ (5)      │ (3)                                │ (4)            ╎
╎     │          ▼                                    ▼                ╎
╎     │   ┌──────┬────────────────────────────────────┬──────────────┐ ╎
╎     │   │ App SQLite files     [SQLite 3, WAL mode, STRICT tables] │ ╎
╎     │   │ <DATA_DIR>/<appId>.sqlite  (+ -wal, -shm)                │ ╎
╎     │   │                                                          │ ╎
╎     │   │ One file per app: tic-tac-toe (columns layout) and       │ ╎
╎     │   │ tic-tac-toe-json (one doc TEXT column). The schema       │ ╎
╎     │   │ descriptor lives in the file; drift fails loudly.        │ ╎
╎     │   └──────────────────────────────────────────────────────────┘ ╎
╎     │                                                                ╎
╰╌╌╌╌╌┬╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯
      ▼
   ┌──┬─────────────────────────────┐
   │ S3-compatible object store     │
   │ [External system]              │
   │                                │
   │ an S3_BASE_URL bucket, or      │
   │ the local ./object-store       │
   │ stand-in directory             │
   │ apps/<appId>/: snapshot,       │
   │ manifest, latest.json          │
   └────────────────────────────────┘
```

## Relationships

| # | From             | To                         | What travels over it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| - | ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Typed client SDK | Server process             | `POST /apps/<appId>/<query\|mutation>/<name>`, `Authorization: Bearer <app token>`, JSON body capped at `MAX_REQUEST_BYTES` (64 KiB by default). `import type` keeps server handlers and database drivers out of the client bundle. Every call carries an `X-Trace-Id` (caller-supplied or a fresh UUID). The server accepts it when it is 1-128 characters of `[A-Za-z0-9._:-]`, otherwise generates one, echoes the id it used on every response, and stamps it on its `http`, `handler`, `sql` and `tx` events (items 22, 34).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2 | Server process   | Reader process             | The server spawns the reader at startup and pings it; a reader that exits while serving ends the server (item 32). The request kinds are `query`, `ping` and `ingest`; `analysis` answers `UnknownAnalysisQuery` until item 23. When a call is made inside a request, its frame carries `traceId`, a fresh `spanId` and the handler span as `parentSpanId` (item 34). The parent-side client is the scoped `ReaderClient` service (`ReaderClientLive` in `platform/ipc.ts`, item 17): it owns the child under `Effect.acquireRelease`, correlates replies through a `Ref` of `Deferred`s, caps the outbox at 1000 calls (`QueueFullError`) and times out each call (default 30 s). Requests and replies are newline-delimited JSON over the child's stdin/stdout, framed by the pure decoder in `core/ipc/framing.ts` (item 05). The reader's **stdout is reserved for this protocol** — its logs go to its own `<LOG_DIR>/reader/` log directory since item 16. |
| 3 | Server process   | App SQLite files           | `node:sqlite` `DatabaseSync`. One writer per app, serialized by a per-app queue; each mutation runs in one `BEGIN IMMEDIATE … COMMIT`, and the handler's own `db.get`/`db.find` calls execute inside that same transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4 | Reader process   | App SQLite files           | DuckDB's `sqlite` extension, `ATTACH … (TYPE SQLITE, READ_ONLY)` against the **live** file — there is no second copy and no replication lag. Query handlers are serialized, one at a time, each in a fresh transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5 | Server process   | S3-compatible object store | `VACUUM INTO` a temp snapshot (serialized with mutations) → `PRAGMA quick_check` → SHA-256 → PUT the immutable snapshot → PUT its manifest → only then PUT `latest.json`. The upload runs after the mutation queue is released. A failed upload never advances `latest.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Why there are two processes

`platform/duckdb.ts` carries the load-bearing constraint: DuckDB's `sqlite` extension and Node's `node:sqlite`
are **two copies of the SQLite library**, and DuckDB documents a warning against linking both into one address
space. The OS-process boundary exists for exactly that reason, and Deno Workers are not a substitute for it.

Two invariants follow, and the plan's item 26 adds a test that greps for violations:

- the server process never imports `@duckdb/node-api`;
- the reader process never imports `node:sqlite`.

The event-log ingest service (item 21) also loads DuckDB and must stay out of the server module graph. It is
mounted by `platform/reader.ts` through `platform/reader_layers.ts` (item 33), and
`tests/unit/server_scope_test.ts` and `tests/unit/reader_ingest_test.ts` check both import graphs. See the
observability diagram.

## Containers deliberately left out

- **`scripts/restore.ts`** reads `latest.json` and the snapshot back from the object store, verifies the hash
  and integrity, and creates a **new** database file at a new path. It is an offline operation — the service
  must be stopped — so it is not part of the running topology. It is a container in its own right and belongs
  in this diagram if restore ever becomes an online path.
- **`scripts/demo.ts`** and **`scripts/explain.ts`** are developer tools, not runtime containers.
- **Logging, the DuckDB event-log artifact and k6** are in the observability diagram.
