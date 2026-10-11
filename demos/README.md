# Runnable demos

Run these commands from the repository root with a current Deno 2 runtime:

```sh
export PATH="$HOME/.deno/bin:$PATH"
```

Demos use `deno run` because `deno.json` is frozen after item 01; there are no `demo:*` tasks or nested
`deno.json` files. The root import map and lockfile apply. Native DuckDB dependencies and its SQLite extension
need network access on first use.

Each directory contains one Effect program and its own private lifecycle helper. Each run creates a temp root,
chooses an independent free port, starts the existing `platform/server.ts` command, and waits up to 30 seconds
for `/health`. Scoped finalizers send SIGTERM, await the server's exit (which closes the reader), and remove
the temp root, including on failed assertions. Data, logs, and local objects stay under that root. The helpers
isolate configuration from ambient deployment settings and use private demo tokens. Nothing is written to the
repository's `data/`, `logs/`, or `object-store/` directories.

You can copy a demo directory without either other demo directory; it still needs the repository's `sdk/`,
`app/`, `core/`, server, restore script where applicable, and root dependency configuration. Every demo
asserts its results and exits nonzero with the assertion's name on failure. The success marker is printed
after scoped cleanup and is the final line.

## Documents and queries

```sh
deno run -A demos/documents/main.ts
```

Plays the same five-move game against the registered `tic-tac-toe` (columns) and `tic-tac-toe-json` (JSON)
apps using the typed Effect `createClient`. Exercises `createGame`, `getGame`, `makeMove`, status-filtered
`listGames`, ordered `moveHistory`, and `winsByMark` (`countBy`). It asserts initial state, version
increments, the winning board, read-after-write, filters, move order, and aggregate counts, then compares both
layouts' document shapes and aggregates with generated identities/timestamps removed (including move foreign
keys).

A stale expected version produces HTTP 409; a fractional cell produces argument-validation HTTP 400. The SDK
exposes these as `RemoteError` with a status and remote tag, without the original structured payload. The demo
verifies both fields, constructs `ConflictError`/`SchemaError` from the known request and state, and handles
them through `Effect.catchTag`. It also checks that rejected moves preserve the version. No named analysis
queries are used.

Expected output tail:

```text
tic-tac-toe-json: handled ConflictError (409)
tic-tac-toe-json: handled SchemaError (400); 5 moves, X wins
Both layouts: identical documents and aggregates (generated identities ignored)
DEMO OK: documents
```

## Backup and restore

```sh
deno run -A demos/backup-restore/main.ts
```

Creates and plays a game, calls the admin-token-protected `POST /admin/backup/tic-tac-toe`, reads
`apps/tic-tac-toe/latest.json` from the local object store, and prints its snapshot key and SHA-256. It
independently verifies the snapshot hash/size and the manifest against the admin response. Then it makes
another move, stops the first server, runs `deno run -A scripts/restore.ts` against a fresh
`restored/tic-tac-toe.sqlite` target with the same `LOCAL_OBJECT_DIR`, and starts a second server on that
restored data directory.

Assertions check that the restored document and move history contain exactly the backed-up state. The live
version advanced from 2 to 3, but restore returns version 2. This makes the deliberate limit visible:
asynchronous backup, not high availability; writes after the snapshot are absent after restore. Features
touched: admin backup, SQLite snapshot, local-object manifest publication, SHA-256 verification, restore
integrity checks, and server shutdown/restart. No named analysis queries are used. The backup timer is
disabled to keep the captured state deterministic.

Expected output tail:

```text
Restored version: 2; post-backup version 3 is absent
Asynchronous backup, not high availability: writes after the snapshot are not restored
DEMO OK: backup-restore
```

## Observability

```sh
deno run -A demos/observability/main.ts
```

Runs a small workload with a caller-supplied `X-Trace-Id` on `getGame`, a stale-version HTTP 409, and an
unknown-handler HTTP 404. Enables `TRACE_SQL`, then calls the admin-token-protected `POST /admin/logs/ingest`
and retries analysis for at most 10 seconds while asynchronous sinks flush. It asserts that the trace spans
the server and reader and contains HTTP and SQL events, and that the error and throughput results account for
both failures.

Prints tables from `POST /admin/logs/analysis/:name` for `handler-throughput`, `error-rate-by-handler`,
`slowest-sql`, and `trace` (with `traceId` as its bound parameter). Analysis request bodies are parameter
objects. The error table contains `ConflictError:1` for `makeMove` and `UnknownHandlerError:1` for
`demoUnknownHandler`; throughput shows one 4xx for each. The demo finishes by printing the `LOG_DIR` tree and
asserting both roles have dated directories. Dates, PIDs, durations, snapshot keys, hashes, and trace IDs vary
per run.

Expected output tail (representative tree):

```text
LOG_DIR tree (logs/<role>/<date>/):
logs/
  reader/
    YYYY-MM-DD/
      events-HH-<pid>-001.jsonl
  server/
    YYYY-MM-DD/
      events-HH-<pid>-001.jsonl
DEMO OK: observability
```
