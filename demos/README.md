# Runnable demos

Run these commands from the repository root with Deno on PATH:

```sh
export PATH="$HOME/.deno/bin:$PATH"
```

Each demo starts its own server and reader on a free local port, keeps its databases, logs and local object
store under a temporary directory, and releases the processes and directory through an Effect scope. These are
real process and database demonstrations: dependencies and the DuckDB SQLite extension must be available. Each
demo asserts its results and exits nonzero with a named assertion on failure. The success line is printed
after its assertions pass; the Effect scope then releases resources.

Demos run via `deno run` because `deno.json` is frozen after item 01. There is no nested demo config.
Lifecycle helpers are deliberately copied into each demo so its directory can be used independently with the
repository's SDK and server.

## Documents

```sh
deno run -A demos/documents/main.ts
```

Runs the same game against the columns (`tic-tac-toe`) and JSON (`tic-tac-toe-json`) layouts through the typed
Effect client. It creates and reads a game, makes moves, filters games by status, reads ordered move history,
and checks `winsByMark` (`countBy`) aggregates. It compares returned documents while normalizing generated
identifiers and creation times.

The demo handles a stale version's HTTP 409 and an argument-validation HTTP 400 with `Effect.catchTag`. The
SDK currently transports server errors as `RemoteError`; the conflict demonstration explicitly adapts a
verified 409/`ConflictError` response to the local tagged class using the known request context. It does not
obtain structured conflict fields from the HTTP response.

Expected output tail:

```text
Columns and JSON layouts agree on game documents, filtered lists, move history, and winsByMark.
DEMO OK: documents
```

## Backup and restore

```sh
deno run -A demos/backup-restore/main.ts
```

Plays a game, calls `POST /admin/backup/tic-tac-toe` using the admin token, and reads
`apps/tic-tac-toe/latest.json` from the local object store. It prints the manifest path, snapshot key and
SHA-256, checks the checksum, then commits another move. After stopping the server, it runs
`scripts/restore.ts` into a new temporary data directory and starts a second server to query the game.

The restored `_version` must equal the version at backup and differ from the newer local version. This makes
the platform's asynchronous backup behavior visible: changes after the snapshot are absent from the restore.
Features touched include SQLite snapshots, local object storage, checksum validation, offline restore, and the
`createGame`, `makeMove` and `getGame` handlers. No analysis queries are used.

Expected output tail (paths and hashes vary):

```text
Restore: {"restored":"<temp>/restored/tic-tac-toe.sqlite","capturedAt":"<timestamp>"}
Restored _version: 3 (post-backup was 4)
DEMO OK: backup-restore
```

## Observability

```sh
deno run -A demos/observability/main.ts
```

Creates a game with a caller-supplied `X-Trace-Id`, performs reads and writes, and deliberately produces one
stale-version 409 and one unknown-handler 404. It calls `POST /admin/logs/ingest` and retries until the trace
id is queryable, with a total deadline of ten seconds covering requests and sleeps.

It calls the following named queries through `POST /admin/logs/analysis/:name` and prints their rows as
tables: `handler-throughput`, `error-rate-by-handler`, `slowest-sql`, and `trace` with a `traceId` parameter.
Assertions require the 409 and 404 in the error-rate results and the caller trace. Finally it prints the real
`LOG_DIR` tree, showing role/date directories. Features touched include HTTP tracing, structured events,
asynchronous log flushing, DuckDB ingestion and named analysis.

Expected output tail (file names and dates vary; the four tables precede this):

```text
LOG_DIR: <temp>/logs/
reader/
  <date>/
    <log-file>.jsonl
server/
  <date>/
    <log-file>.jsonl
DEMO OK: observability
```
