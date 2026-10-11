# Platform developer guide

This guide introduces the TypeScript document API, the two-process runtime, and the operational tools. The
server keeps writes transactional in SQLite and sends reads to a separate DuckDB reader process:

```text
TypeScript client
      | named handler + JSON args
      v
Deno API process ── SQLite write transactions ──> app-specific .sqlite files
      |                                      |
      └── JSON-lines RPC ──> DuckDB reader ──┘
      |
      └── consistent snapshots ──> local object store or S3-compatible storage
```

The processes share one machine and filesystem. Read [README → Deliberate limits](README.md#deliberate-limits)
before treating this prototype as a production service.

## Installation

Install Deno **2.9.5**. In agent shells, add its install directory to `PATH`:

```sh
export PATH="$HOME/.deno/bin:$PATH"
deno --version
```

The repository commits `deno.lock`; keep it with the source so dependency versions stay reproducible. The
first dependency resolution needs network access for the pinned npm packages. On the first server start,
DuckDB also needs network access to download its `sqlite` extension. Later starts can use the cached files.

## Configuration

[README → Configuration](README.md#configuration) is the single source of truth for all options and their
defaults; this guide intentionally does not duplicate its options table. The first settings most developers
change are `PORT` (default `8000`) for the HTTP listener and `DATA_DIR` (default `./data`) for per-app SQLite
files. Set `ADMIN_TOKEN` (default `dev-only`), `COLUMN_APP_TOKEN` (default `dev-only`), and `JSON_APP_TOKEN`
(default `dev-only`) before exposing the service; those defaults are for local development.
`BACKUP_INTERVAL_MS` (default `0`) disables scheduled backups until set to at least 1000 milliseconds.
`LOG_DIR` (default `./logs`) sets the root for process logs.

Configuration is decoded once during startup. Invalid values, such as `BACKUP_INTERVAL_MS=500` or an
`S3_BASE_URL` without both required credentials, fail fast with a typed `ConfigError`; the server does not
start serving with partial configuration.

## Core concepts

**Documents** are typed records in a collection. The application schema defines its fields; the platform owns
`_id`, `_creationTime`, and `_version`. Patches increment `_version`, and application code cannot write those
metadata fields.

**Collections** are called tables in code: declare one with `defineTable`, then access it with operations such
as `db.find("games", { status: "playing" })`. The two registered apps use the same logical schema but
different storage layouts. `tic-tac-toe` stores fields as SQLite columns; `tic-tac-toe-json` stores a JSON
document in each row. Both return the same TypeScript document shape. Existing database files reject schema or
storage-layout drift; this platform has no automatic migration.

**Functions** are named `query` or `mutation` handlers. Public queries run in the DuckDB reader process and
receive a read-only database interface. Mutations run in the API process; their reads and writes use SQLite
inside one `BEGIN IMMEDIATE` transaction, so a multi-step mutation commits atomically or rolls back together.
The SDK creates typed `Effect` values; the platform decides where and when to run them. See
[README → Transaction contract](README.md#transaction-and-consistency-contract) for visibility and concurrency
details.

The deployment registry is static. Adding an app means editing `platform/registry.ts` and
`platform/config.ts`; there is no plugin loading or uploaded-code execution.

## SDK walkthrough

The schema below is a complete module. Fields are validated at the function boundary, while platform metadata
is added by the runtime.

```ts
import { defineSchema, defineTable, v } from "./sdk/schema.ts";

export const schema = defineSchema({
  games: defineTable({
    title: v.string(),
    status: v.enum("open", "closed"),
  }).index("by_status", ["status"]),
});
```

Queries and mutations return typed effects. The mutation example reads and patches within the same write
transaction; `NotFoundError` remains in its error channel instead of being thrown as an untyped exception.

```ts
import { Effect } from "effect";
import { NotFoundError } from "./core/errors.ts";
import { defineFunctions } from "./sdk/functions.ts";
import { v } from "./sdk/schema.ts";
import { schema } from "./app/schema.ts";

const { query, mutation } = defineFunctions(schema);

export const functions = {
  openGames: query({
    args: {},
    handler: ({ db }) =>
      db.find("games", { status: "playing" }).sort("_creationTime", "desc").limit(20).collect(),
  }),
  markDraw: mutation({
    args: { id: v.string() },
    handler: ({ db }, { id }) =>
      Effect.gen(function* () {
        const game = yield* db.get("games", id);
        if (!game) return yield* new NotFoundError({ table: "games", id });
        yield* db.patch("games", id, { status: "draw" });
        return yield* db.get("games", id);
      }),
  }),
};
```

The HTTP client infers handler names, arguments, and results from the server's function type. A remote typed
failure is a `RemoteError` in the client's error channel and can be handled with `Effect.catchTag`:

```ts
import { Effect } from "effect";
import { createClient } from "./sdk/client.ts";
import type { functions } from "./app/functions.ts";

const client = createClient<typeof functions>(
  "http://127.0.0.1:8000",
  "tic-tac-toe",
  "dev-only",
);

const run = client.query("getGame", { gameId: "missing-game" }).pipe(
  Effect.catchTag("RemoteError", (error) => Effect.succeed({ failure: error.remoteTag ?? error.message })),
);

console.log(await Effect.runPromise(run));
```

## Running the server

Start the API and its DuckDB reader with `deno task serve`. In another terminal, check readiness:

```sh
curl --fail http://127.0.0.1:8000/health
```

The static registry serves `tic-tac-toe` (column layout) and `tic-tac-toe-json` (JSON layout). All three
tokens default to `dev-only`; replace them before using anything beyond a trusted local demo. `GET /health`
does not require a token. App calls use their app bearer token; `/admin/*` calls use the admin token.

Typed failures map to HTTP statuses as follows:

| Status | Examples                                                                     |
| ------ | ---------------------------------------------------------------------------- |
| 400    | Invalid schema or query, rule failure, wrong handler kind                    |
| 401    | Missing or invalid bearer token                                              |
| 404    | Unknown route, app, handler, or document                                     |
| 409    | Stale `_version` conflict or backup already running (conflict status change) |
| 413    | Request body exceeds `MAX_REQUEST_BYTES`                                     |
| 500    | Storage, backup, analysis, or server-side failure                            |
| 502    | Reader exited, IPC failed, or object-store request failed                    |
| 503    | Bounded work queue is full; retry may succeed (load-shedding status change)  |

The response includes an error tag. For server-side failures, use the returned trace ID to find the full
detail in logs.

## Backups and restore

Request a manual snapshot through the admin endpoint:

```sh
curl --fail -X POST http://127.0.0.1:8000/admin/backup/tic-tac-toe \
  -H 'Authorization: Bearer dev-only'
```

`BACKUP_INTERVAL_MS` enables a timer for periodic snapshots. Without `S3_BASE_URL`, the local object-store
stand-in writes under `LOCAL_OBJECT_DIR`; it is useful for local exercises but is not off-host protection. For
S3-compatible storage, configure a bucket URL and credentials on the server:

```sh
# not run: needs S3 credentials
export S3_BASE_URL='https://example-bucket.s3.us-east-1.amazonaws.com'
export AWS_REGION='us-east-1'
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
BACKUP_INTERVAL_MS=60000 deno task serve
```

Restore is offline: stop the service, then restore a selected app to a new database path. The command checks
the manifest, hash, and SQLite integrity and refuses to overwrite a destination or its WAL/SHM companions. For
local stand-in backups:

```sh
deno task restore tic-tac-toe ./restored-data/tic-tac-toe.sqlite
```

This is asynchronous backup, not high availability. A successful mutation acknowledges its local SQLite
commit, not an off-host copy; a host loss can discard writes newer than the last completed snapshot.

## Observability

Process logs are JSONL files under `logs/<role>/<date>/`, with separate role directories for server, reader,
restore, and CLI activity. `deno task logs:ingest` imports available JSONL events to DuckDB;
`deno task logs:query` runs named analyses; `deno task logs:sweep` applies log retention. The three task names
are declared in `deno.json`, but their shared `scripts/logs.ts` CLI is absent from this checkout, so the
commands cannot run yet. The admin routes are `POST /admin/logs/ingest` and `POST /admin/logs/analysis/:name`
(admin bearer token required). Ingest before querying new log files.

Named analyses from the plan are one key per question: `slowest-sql` (SQL latency percentiles), `plan-shapes`
(compiled SQL frequency and latency), `error-rate-by-handler` (request errors by handler),
`mutation-vs-query-latency` (write/read latency), `handler-throughput` (requests and statuses over time),
`queue-depth` (queue high-water marks and drops), `tx-outcomes` (commits, rollbacks, and queue wait),
`backup-history` (backup phases and gaps), `trace` (ordered events for one trace ID), and `k6-vs-platform`
(client and server latency by scenario). The item-23 catalog and `logs:query` CLI are not present on this
branch yet; these names come from the plan's catalog. See [docs/observability.md](docs/observability.md) for
event table schemas; do not infer schemas from the query names.

For a request-to-log workflow, send a caller-chosen `X-Trace-Id` with an app request or let the client create
one, then keep the echoed response header. After ingesting the JSONL files, query `trace` with that ID to join
the API request, mutation/read events, and SQL activity across both processes once item 23's catalog lands.

## Troubleshooting

- **`deno: command not found`** → Deno is missing from the shell path → run
  `export PATH="$HOME/.deno/bin:$PATH"`.
- **`ConfigError` at startup** → an option is malformed or out of range, such as `BACKUP_INTERVAL_MS=500`, or
  `S3_BASE_URL` is set without both AWS credentials → correct the environment and restart.
- **DuckDB extension download fails** → the first run cannot reach the extension download host → allow network
  access for the DuckDB `sqlite` extension, then restart.
- **Schema drift when opening an existing data file** → its stored schema or layout differs from the
  registered app → restore/use a matching file or choose a fresh `DATA_DIR`; there is no automatic migration.
- **401 response** → the bearer token is absent or does not match the app/admin token → send the correct
  `Authorization: Bearer …` header.
- **404 response** → route, app ID, handler name, or document ID does not exist → check the exact registered
  name and request path.
- **409 response** → a mutation used a stale `_version`, or a backup for that app is already running → refresh
  the document version and retry the intended operation after the backup completes.
- **413 response** → request body exceeds `MAX_REQUEST_BYTES` → send a smaller body or raise the configured
  limit deliberately.
- **503 response** → bounded server or reader queue is full → reduce concurrent work and retry with
  caller-controlled backoff.
- **Reader exited / 502 response** → the DuckDB child failed, timed out, or lost IPC → inspect reader-role
  logs with the response trace ID and restart after resolving the underlying error.
- **Port already in use** → another process owns `PORT` → stop it or select another `PORT` value.
