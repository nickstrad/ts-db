# Document DB MVP — TypeScript document API, SQLite storage, DuckDB queries

**Application authors write schemas and document operations, not SQL.** The platform captures document
operations as a small intermediate representation and compiles them to SQLite or DuckDB SQL. Regular
TypeScript control flow (the tic-tac-toe rules) still runs as TypeScript.

## Verification status

- **Executed successfully:** 20 core tests using Node 22.16.0's real `node:sqlite` adapter. Tests cover both
  storage layouts, transactional rollback, competing moves, validation, SQL parameter binding, app-file
  separation, generated read SQL, result decoding, schema-drift rejection, and WAL-safe snapshots. See
  `tests/CORE_TEST_RESULTS.txt`.
- **Type-checked successfully:** SDK, tic-tac-toe schema/handlers, compiler, SQLite adapter, core tests, and
  compile-only API type tests with TypeScript 5.8.3.
- **Not executed here:** Deno server/subprocess transport, the native DuckDB adapter, the end-to-end
  integration test, and actual S3 uploads. This build environment did not have Deno/DuckDB and could not
  download them. Do not treat this as a fully integration-tested service.
- DuckDB native API calls were checked against official documentation and source. The package pins
  `@duckdb/node-api@1.5.6` and `aws4fetch@1.0.20`. No dependency lockfile was fabricated; generate and commit
  `deno.lock` after resolving dependencies locally.

## Start here to skim

| File                   | What it demonstrates                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `app/schema.ts`        | The developer's schema builder: typed fields and indexes.                                  |
| `app/functions.ts`     | All application code: create/move/delete mutations, reads, grouped statistics. No SQL.     |
| `sdk/db.ts`            | Document operations become an engine-neutral query plan.                                   |
| `platform/compiler.ts` | Schema to DDL; query plan to dialect-specific SQL; document writes to SQL; row decoding.   |
| `platform/sqlite.ts`   | Per-app mutation serialization and SQLite transactions, including mutation-internal reads. |
| `platform/duckdb.ts`   | Read-only attachment of the same SQLite file; generated DuckDB queries.                    |
| `platform/server.ts`   | Named-handler routing and the second-process lifecycle.                                    |
| `platform/backup.ts`   | Consistent SQLite snapshot, checksum, immutable object, latest manifest.                   |

`GENERATED_SQL.txt` shows actual compiler output for the two layouts and two dialects. `deno task explain`
regenerates it without running either database engine.

## Minimum process model

```text
TypeScript client / browser
     |
     | named handler + JSON args (never raw SQL)
     v
Deno process 1: HTTP API + SQLite mutation handlers + optional backup timer
     |                  |
     | write/read tx    | JSON-lines RPC over stdin/stdout
     v                  v
app.sqlite <------ Deno process 2: query handlers + DuckDB SQLite extension
     |
     | consistent VACUUM INTO snapshot
     v
local snapshot -> S3-compatible object store
```

Both long-lived processes run on **the same machine with the same local filesystem**. The server starts the
reader automatically. The two demo app IDs share these processes but have independent files. There is no
persistent DuckDB database, no CDC pipeline, no replica-copy refresh loop, and no extra backup daemon.

SQLite writes use `node:sqlite`. DuckDB uses its SQLite extension to read the live file. The processes are
separated because DuckDB documents a warning about linking multiple SQLite-library copies into one
application. Deno Workers/threads are not substituted for that OS-process boundary.

## Run

Use a recent Deno 2 runtime (Deno 2.2+ includes `node:sqlite`; a current Deno 2 release is the intended
target). The native DuckDB npm module needs local `node_modules` plus FFI permission. `nodeModulesDir: auto`
and the local demo's `-A` cover those requirements. Dependencies and the DuckDB `sqlite` extension need
network access on first use. This is native Deno, not a browser-WASM example or an edge-runtime deployment.

From this directory:

```sh
# Terminal 1. Also starts the DuckDB reader process.
TRACE_SQL=1 deno task serve

# Terminal 2. Runs a complete game using the typed HTTP client.
deno task demo

# Same application API and handlers, independent app, all-JSON physical layout.
deno task demo tic-tac-toe-json

# Inspect compiler output without database drivers.
deno task explain

# Core tests, API type checks, then the real multi-process integration test.
deno task test
deno task check
deno task integration
```

The service binds to `127.0.0.1:8000`. Default app/admin tokens are `dev-only`, deliberately unsuitable for
deployment. Set `PORT`, `DATA_DIR`, `COLUMN_APP_TOKEN`, `JSON_APP_TOKEN`, and `ADMIN_TOKEN` as needed. Do not
expose this service to untrusted users. `TRACE_SQL=1` includes bound application values in logs.

## App-facing client

```ts
import { createClient } from "./sdk/client.ts";
import type { functions } from "./app/functions.ts";

const client = createClient<typeof functions>(
  "http://127.0.0.1:8000",
  "tic-tac-toe",
  "dev-only",
);
const { gameId } = await client.mutation("createGame", {
  xPlayer: "alice",
  oPlayer: "bob",
});
const game = await client.query("getGame", { gameId });
await client.mutation("makeMove", {
  gameId,
  playerId: "alice",
  cell: 0,
  expectedVersion: game!._version,
});
const stats = await client.query("winsByMark", {});
```

`import type` does not send server handlers or database libraries to the client. Handler names, argument
types, and result types are inferred. There is no code-generation step in this small example.

## Query language and semantics

Supported: `get`, `find` with top-level scalar equality, chained `where`, numeric `gt`, `sort`, `limit`,
`collect`, `first`, `count`, `countBy`; and `insert`, `patch`, `delete` within mutations.

```ts
await db.find("games", { status: "playing" })
  .sort("_creationTime", "desc").limit(20).collect();

await db.find("games", { status: "won" }).countBy("winner");
```

The first operation produces a plan such as:

```json
{
  "kind": "select",
  "table": "games",
  "filters": [{ "field": "status", "op": "eq", "value": "playing" }],
  "order": { "field": "_creationTime", "direction": "desc" },
  "limit": 20
}
```

Only platform code converts it to SQL. Identifiers are schema-validated, values use bound parameters, and
array predicates/unknown fields fail explicitly. This is not a compiler for arbitrary JavaScript closures,
MongoDB's entire query language, or Convex's full API. No hidden fetch-everything-and-filter-in-JavaScript
fallback is provided.

All fields are required unless explicitly nullable; there is no separate missing/undefined field state. Arrays
are validated recursively and stored as JSON text. Optional fields, nested-object schemas, joins, array
predicates, MongoDB operators, projection, cursors, and search are not implemented. Collection reads default
to 100 results and are capped at 1000. `count` counts all matching documents regardless of limit; `countBy`
groups all matches and caps returned groups. Sorting adds `_id` as a stable tie-breaker and spells out null
ordering.

`_id`, `_creationTime`, and `_version` are platform-owned metadata; each patch increments `_version`. Typed
clients cannot patch metadata. Arguments and writes also receive runtime validation.

## Two physical layouts, same logical schema

`tic-tac-toe` uses columns. Strings/enums become TEXT, integers/booleans INTEGER, numbers REAL, and board
arrays JSON-encoded TEXT. Generated tables use SQLite STRICT mode.

`tic-tac-toe-json` uses `_id`, `_creationTime`, `_version`, and one `doc TEXT` JSON document per row. The same
schema validates the JSON. Index declarations compile to SQLite JSON expression indexes. This is JSON text,
not SQLite's binary JSONB encoding, so DuckDB can consume it as JSON text.

In columns mode, `status = "playing"` targets the `status` column. In JSON mode the SQLite compiler uses
`json_extract(doc, '$.status')`; the DuckDB compiler uses `json_extract_string(doc, '$.status')`.
Numeric/boolean extraction has explicit casts in the DuckDB dialect. The result decoder returns the same
TypeScript document shape in either layout and normalizes safe-integer BIGINT results to JS numbers.

Schema descriptors are stored in each file. Changing a schema or storage mode on an existing file fails
explicitly. There is no automatic migration or live schema reload.

## Transaction and consistency contract

A mutation gets one per-app queue slot and one `BEGIN IMMEDIATE ... COMMIT` transaction. Its `db.get` and
`db.find` calls execute through SQLite **inside the same transaction**. The board update and inserted move are
atomic. If validation or game logic throws, both roll back. Concurrent move attempts are serialized, and
`expectedVersion` rejects a stale client attempt.

Public `query` handlers execute in the DuckDB process and get a read-only document context. The attached
SQLite database is READ_ONLY. The worker serializes whole query handlers and scopes each handler to a fresh
transaction, so it does not intentionally reuse an earlier transaction snapshot across requests. The
integration test specifically checks read-after-write visibility on the real extension.

The mutation response returns the locally committed game immediately. DuckDB is never used to make
transactional write decisions. There is no second data copy that needs to catch up. This does not establish a
remotely replicated/linearizable database service; concurrent readers may legitimately see the state before an
overlapping write.

## Backups and restore

Manual backup, using the local object-store stand-in by default:

```sh
curl -X POST http://127.0.0.1:8000/admin/backup/tic-tac-toe \
  -H 'Authorization: Bearer dev-only'
```

For actual off-host backups, configure an S3-compatible bucket base URL and credentials on the server:

```sh
export S3_BASE_URL='https://YOUR_BUCKET.s3.us-east-1.amazonaws.com'
export AWS_REGION='us-east-1'
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
# AWS_SESSION_TOKEN is supported for temporary credentials.
# For a compatible path-style service, base URL includes /bucket-name.

BACKUP_INTERVAL_MS=60000 deno task serve
```

The credentials need object GET/PUT permissions. They are server-side only. The signer does not implement a
cloud SDK credential-provider chain or automatic refresh of environment-supplied temporary credentials. Supply
renewed credentials/restart as appropriate for this demo.

The flow is
`VACUUM INTO new-file -> PRAGMA quick_check -> SHA-256 -> immutable snapshot PUT -> immutable manifest PUT -> latest manifest PUT`.
It does not copy the live SQLite main file while ignoring the WAL. Snapshot creation serializes with local
mutations; upload runs after releasing the mutation queue. There is one backup in progress per app and no
overlapping periodic backup sweep.

Snapshots live under `apps/<appId>/<timestamp>-<uuid>.sqlite`, with a manifest alongside each snapshot.
`apps/<appId>/latest.json` is published after successful snapshot upload. A failed upload does not advance the
latest manifest. Each snapshot contains an entire app, not one row or one table.

To restore, **stop the service and restore to a new path**, without an existing database/WAL/SHM there. The
command reads `latest.json`, verifies the hash and integrity, and creates the destination without overwriting
an existing database. Run it with the same object-store environment as the server:

```sh
deno task restore tic-tac-toe ./restored-data/tic-tac-toe.sqlite
# Restore the other app separately if needed, then start with:
DATA_DIR=./restored-data deno task serve
```

The restore publishes a complete temporary file with a same-filesystem hard link. It is an offline operation,
not an automatic live-database replacement. Server startup does not automatically restore absent files; absent
app files are initialized empty.

**This is asynchronous backup, not high availability.** A successful mutation acknowledges local SQLite
commit, not S3 durability. A host loss can lose commits newer than the last completed snapshot. Backup
intervals do not guarantee a fixed RPO during upload delays or failures. There is no leader election,
replicated WAL, failover, incremental upload, retention policy, or live restore. Full snapshots read the
entire database into memory before upload; replace that path before using large databases. Local
`object-store/` is not off-host redundancy.

## Configuration

`platform/config.ts` is the single env boundary: `ConfigLive` reads every option below once, at layer
construction, and fails with a typed `ConfigError` rather than at first use. Every option is declared exactly
once, in `platform/config.ts`'s options table — this section is checked against that table mechanically
(`tests/unit/config_test.ts`), so it always lists the current platform version's options. Empty-string env
values are treated the same as unset. `ConfigTest(overrides)` ignores the environment entirely and is for
tests.

| Option                 | Env var                   | Type                           | Default                      | Description                                                                                                                       |
| ---------------------- | ------------------------- | ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `port`                 | `PORT`                    | number                         | `8000`                       | HTTP server port.                                                                                                                 |
| `bindHost`             | `BIND_HOST`               | string                         | `127.0.0.1`                  | HTTP server bind address.                                                                                                         |
| `maxRequestBytes`      | `MAX_REQUEST_BYTES`       | number                         | `65536`                      | Request body cap in bytes; larger bodies are rejected before parsing.                                                             |
| `dataDir`              | `DATA_DIR`                | string                         | `./data`                     | Root directory for per-app SQLite files, resolved to an absolute path.                                                            |
| `adminToken`           | `ADMIN_TOKEN`             | string                         | `dev-only`                   | Bearer token for the /admin/* routes.                                                                                             |
| `columnAppToken`       | `COLUMN_APP_TOKEN`        | string                         | `dev-only`                   | Bearer token for the tic-tac-toe app (columns storage).                                                                           |
| `jsonAppToken`         | `JSON_APP_TOKEN`          | string                         | `dev-only`                   | Bearer token for the tic-tac-toe-json app (json storage).                                                                         |
| `backupIntervalMs`     | `BACKUP_INTERVAL_MS`      | number                         | `0`                          | Backup timer period in milliseconds. 0 disables the timer; otherwise must be finite and >= 1000.                                  |
| `logDir`               | `LOG_DIR`                 | string                         | `./logs`                     | Root of the logs/<role>/<date>/ tree.                                                                                             |
| `logLevel`             | `LOG_LEVEL`               | enum(debug\|info\|warn\|error) | `info`                       | Minimum event level written to the log.                                                                                           |
| `logRetentionDays`     | `LOG_RETENTION_DAYS`      | number                         | `30`                         | Days a log file is kept before deletion.                                                                                          |
| `logGzipAfterDays`     | `LOG_GZIP_AFTER_DAYS`     | number                         | `7`                          | Days a log file is kept uncompressed before gzip.                                                                                 |
| `logMaxTotalBytes`     | `LOG_MAX_TOTAL_BYTES`     | number                         | `1073741824`                 | Total bytes the log tree may occupy before the oldest files are swept.                                                            |
| `logMaxFileBytes`      | `LOG_MAX_FILE_BYTES`      | number                         | `67108864`                   | Bytes a single log file may reach before it rolls over.                                                                           |
| `logIncludeBindValues` | `LOG_INCLUDE_BIND_VALUES` | boolean                        | `false`                      | Include SQL bind values in sql events. Off by default: bind values are application data. Accepts true/false, 1/0, yes/no.         |
| `traceSql`             | `TRACE_SQL`               | boolean                        | `false`                      | Emit an event for every compiled SQL statement. Accepts true/false, 1/0, yes/no.                                                  |
| `eventQueueCapacity`   | `EVENT_QUEUE_CAPACITY`    | number                         | `10000`                      | Depth of the in-process dropping queue that buffers events before they are flushed to disk.                                       |
| `eventFlushMs`         | `EVENT_FLUSH_MS`          | number                         | `250`                        | Interval in milliseconds between batched event-queue flushes.                                                                     |
| `s3BaseUrl`            | `S3_BASE_URL`             | optional-string                | `(unset)`                    | Base URL of the S3 (or S3-compatible) bucket for backups. Absent selects the local object-store stand-in.                         |
| `awsRegion`            | `AWS_REGION`              | string                         | `us-east-1`                  | AWS region used to sign S3 requests.                                                                                              |
| `awsAccessKeyId`       | `AWS_ACCESS_KEY_ID`       | optional-string                | `(unset)`                    | AWS access key id. Required when S3_BASE_URL is set.                                                                              |
| `awsSecretAccessKey`   | `AWS_SECRET_ACCESS_KEY`   | optional-string                | `(unset)`                    | AWS secret access key. Required when S3_BASE_URL is set.                                                                          |
| `awsSessionToken`      | `AWS_SESSION_TOKEN`       | optional-string                | `(unset)`                    | AWS session token, for temporary credentials.                                                                                     |
| `localObjectDir`       | `LOCAL_OBJECT_DIR`        | string                         | `./object-store`             | Local object-store directory used when S3_BASE_URL is unset, resolved to an absolute path.                                        |
| `eventlogDuckdbPath`   | `EVENTLOG_DUCKDB`         | string                         | `<DATA_DIR>/eventlog.duckdb` | Persistent DuckDB file backing the ingested event log, resolved to an absolute path. Defaults to eventlog.duckdb inside DATA_DIR. |

## Deliberate limits

This is a local, trusted-application prototype. Two database files are not a hostile-tenant security sandbox.
Handlers are statically registered modules; uploaded code execution, per-tenant process isolation, deployment
tooling, authenticated end-user identity, row-level authorization, and secret isolation are not implemented.
`playerId` is supplied by the demo caller, not verified identity. App-level shared bearer tokens are only a
basic routing/access check. Client mutations have no automatic retry or idempotency key, so a network timeout
can leave an unknown commit outcome.

One writer connection per app and one shared serial reader process are enough to expose the design, not to
establish capacity. SQLite's synchronous API and snapshot creation can block the API event loop. There are
queue-size and result-size caps but no complete deadline/cancellation, overload, restart, or
resource-governance policy. Avoid network I/O or long-running work inside mutation handlers. All long-lived
processes must remain on one local filesystem; object storage is a backup target, not a mounted live SQLite
volume.

Reactive subscriptions, automatic dependency tracking, optimistic UI, durable actions/jobs, automatic
migrations, production authentication, and a full query optimizer are not included. Routing all reads through
DuckDB demonstrates the requested architecture; it is not a claim that this is faster than SQLite indexed
point reads. In a later design, the platform could select SQLite for transactional point reads and DuckDB for
analytical plans without changing the SDK. Benchmark the actual extension's scan/predicate behavior rather
than assuming every declared SQLite index accelerates every DuckDB query.

## Primary references

- Deno SQLite API: https://docs.deno.com/api/node/sqlite/
- Deno native npm/Node-API compatibility: https://docs.deno.com/runtime/fundamentals/node/
- DuckDB SQLite extension (live-file access and multiple-SQLite-library warning):
  https://duckdb.org/docs/current/core_extensions/sqlite
- DuckDB Node Neo API: https://duckdb.org/docs/current/clients/node_neo/overview
- DuckDB JSON functions: https://duckdb.org/docs/current/data/json/json_functions
- SQLite VACUUM INTO guarantees: https://www.sqlite.org/lang_vacuum.html
- aws4fetch signer: https://github.com/mhart/aws4fetch
