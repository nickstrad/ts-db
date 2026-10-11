# C4 Level 3 — Component: inside the server process

Renderings: [GitHub](c4-component-server.github.md) · [terminal](c4-component-server.terminal.md).

## What this shows

The live server composition is `PlatformLive` in `platform/layers.ts` (item 22). The HTTP router resolves
per-app stacks through `AppServices`; it is not provided a single global `Storage`. All components shown
inside the boundary are implemented and mounted. The reader and persistent stores are boundary elements. The
pure kernel and service tags are compile-time modules used by these components, not runtime services.

```mermaid
flowchart TB
    subgraph scope["Server process - PlatformLive (item 22)"]
        http["HTTP API<br/>[Component] (item 22)<br/>platform/http/<br/>router.ts, auth.ts, handlers.ts<br/>Bearer auth; body cap; trace ID; typed HTTP errors"]
        life["Server lifecycle<br/>[Component] (item 22)<br/>platform/server.ts<br/>Scoped HTTP listener, backup fiber, signal handling"]
        apps["AppServices<br/>[Effect service] (item 22)<br/>platform/registry.ts<br/>AppServicesLive: platform/layers.ts<br/>One Storage + Backups stack per app"]
        registry["AppRegistry<br/>[Effect service] (item 22)<br/>platform/registry.ts<br/>Config apps -&gt; schema, handlers, token, SQLite path"]
        storage["Storage<br/>[Effect service] (item 15)<br/>platform/sqlite.ts<br/>Per-app scoped SQLite handle; serialized mutation/snapshot queue"]
        backups["Backups<br/>[Effect service] (item 19)<br/>platform/backup.ts<br/>Per-app snapshot, verification, hash and publication"]
        rpc["ReaderClient<br/>[Effect service] (item 17)<br/>platform/ipc.ts<br/>Scoped child; Deferred replies; queue cap and deadline"]
        objects["ObjectStore<br/>[Effect service] (item 18)<br/>platform/object_store.ts<br/>Local files or signed S3; transient S3 retries"]
        logs["Logger + EventSink<br/>[Effect logger/service] (11)<br/>platform/logging/<br/>logger.ts, file_sink.ts<br/>Dropping queue; JSONL batches; scope finalizer drains"]
        config["Config<br/>[Effect service] (item 08)<br/>platform/config.ts<br/>Validated environment options; startup failure on invalid config"]
        ids["IdGen<br/>[Effect service]<br/>platform/sqlite.ts<br/>IdGenLive: random UUIDs<br/>Clock: Effect runtime service"]
    end
        reader["Reader process<br/>[Deno child process]<br/>platform/reader.ts"]
        files["App SQLite files<br/>[SQLite 3, WAL]<br/>&lt;DATA_DIR&gt;/&lt;appId&gt;.sqlite"]
        store["Object storage<br/>[External system/filesystem]<br/>S3_BASE_URL or OBJECT_STORE_DIR<br/>apps/&lt;appId&gt;/"]
        jsonl["JSONL directories<br/>[filesystem]<br/>&lt;LOG_DIR&gt;/server/&lt;date&gt;/"]
    life -->|"(1) serves HTTP requests"| http
    http -->|"(2) resolve per-app stack"| apps
    life -->|"(3) scheduled backups"| apps
    apps -->|"(4) enumerate app definitions"| registry
    apps -->|"(5) build/expose per-app writer"| storage
    apps -->|"(6) build/expose per-app backup"| backups
    http -->|"(7) health app list"| registry
    http -->|"(8) query, ping, ingest, analysis"| rpc
    backups -->|"(9) snapshot(path)"| storage
    backups -->|"(10) PUT snapshot and manifests"| objects
    http -->|"(11) HTTP and defect records"| logs
    life -->|"(12) lifecycle records"| logs
    storage -->|"(13) SQL, tx and queue records"| logs
    rpc -->|"(14) IPC lifecycle and queue records"| logs
    backups -->|"(15) backup phase records"| logs
    objects -->|"(16) object operation records"| logs
    config -->|"(17) auth and request limits"| http
    config -->|"(18) listener and backup settings"| life
    config -->|"(19) registered app settings"| registry
    config -->|"(20) logging settings"| storage
    config -->|"(21) configured call deadline"| rpc
    config -->|"(22) object-store settings"| objects
    config -->|"(23) sink and log settings"| logs
    ids -->|"(24) new trace IDs"| http
    ids -->|"(25) generated IDs"| storage
    ids -->|"(26) generated IDs"| backups
    ids -->|"(27) generated IDs"| objects
    storage -->|"(28) node:sqlite writes"| files
    rpc -->|"(29) stdin/stdout JSON-lines RPC"| reader
    objects -->|"(30) signed HTTP or local file I/O"| store
    logs -->|"(31) append JSONL"| jsonl
    classDef planned stroke-dasharray: 5 3
    classDef person fill:#fff,stroke-width:2px
    classDef external fill:#f4f4f4
    class reader external
    class files external
    class store external
    class jsonl external
```

## Relationships

All arrows are listed here in both formats. The terminal uses this key instead of crossing lines.

| #  | From               | To                 | Relationship                                                                                                                    |
| -- | ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Server lifecycle   | HTTP API           | `Deno.serve` invokes the router on the Effect runtime; shutdown drains requests before closing dependencies.                    |
| 2  | HTTP API           | AppServices        | Mutation and admin-backup handlers resolve `AppServices.get(appId)`, then call the stack storage or backups.                    |
| 3  | Server lifecycle   | AppServices        | A scoped `Schedule.spaced` fiber enumerates app stacks and calls backups sequentially. Disabled when `BACKUP_INTERVAL_MS=0`.    |
| 4  | AppServices        | AppRegistry        | `AppServicesLive` enumerates `AppRegistry.all` while building per-app stacks.                                                   |
| 5  | AppServices        | Storage            | One scoped writer per registered app, shared with that app's backups.                                                           |
| 6  | AppServices        | Backups            | `BackupsLive` is provided the matching `StorageLive`.                                                                           |
| 7  | HTTP API           | AppRegistry        | Health lists registered apps and pings the reader.                                                                              |
| 8  | HTTP API           | ReaderClient       | JSON RPC operations. Query and ping work; reader ingest and analysis return typed errors until wired.                           |
| 9  | Backups            | Storage            | `VACUUM INTO` serializes with mutations; verification and upload run after releasing the writer queue.                          |
| 10 | Backups            | ObjectStore        | Snapshot -> quick_check -> SHA-256 -> immutable object -> manifest -> latest.json. Failure cannot publish latest early.         |
| 11 | HTTP API           | Logger + EventSink | One HTTP record per request, trace ID echoed in the response. Router annotates its handler fiber.                               |
| 12 | Server lifecycle   | Logger + EventSink | Startup, stopping, HTTP drain and shutdown events. Shutdown marker runs before final log drain.                                 |
| 13 | Storage            | Logger + EventSink | SQL tracing honors configuration; failed statements and transaction outcomes are recorded.                                      |
| 14 | ReaderClient       | Logger + EventSink | ReaderClient uses its connection trace ID; request trace IDs do not currently cross IPC.                                        |
| 15 | Backups            | Logger + EventSink | Snapshot, verify, hash, put-manifest and publish-latest events; snapshot object PUT is normally recorded by ObjectStore.        |
| 16 | ObjectStore        | Logger + EventSink | PUT emits backup/put-object; GET emits lifecycle records, with outcome and duration.                                            |
| 17 | Config             | HTTP API           | The HTTP components consume the validated admin token and body-size limit.                                                      |
| 18 | Config             | Server lifecycle   | Bind host, port, backup interval and startup token warnings.                                                                    |
| 19 | Config             | AppRegistry        | App IDs, layouts, tokens and data directory.                                                                                    |
| 20 | Config             | Storage            | Storage consumes logging configuration; file/schema/appId arrive through AppServicesLive.                                       |
| 21 | Config             | ReaderClient       | `ReaderClientConfigured` reads `READER_CALL_TIMEOUT_MS` (default 30 seconds).                                                   |
| 22 | Config             | ObjectStore        | Local directory or S3 endpoint/credentials and signing region.                                                                  |
| 23 | Config             | Logger + EventSink | Directory, log level, queue capacity and file rotation policy.                                                                  |
| 24 | IdGen              | HTTP API           | Fallback when the presented X-Trace-Id is absent or invalid.                                                                    |
| 25 | IdGen              | Storage            | Document/event IDs from IdGen; times from Effect Clock.                                                                         |
| 26 | IdGen              | Backups            | Backup IDs and events; phase timings use Effect Clock.                                                                          |
| 27 | IdGen              | ObjectStore        | Temporary object names and operation events.                                                                                    |
| 28 | Storage            | App SQLite files   | `DatabaseSync`; one BEGIN IMMEDIATE transaction per mutation, including handler reads; scoped rollback on failure/interruption. |
| 29 | ReaderClient       | Reader process     | Child in its own process group; finalizer closes stdin, waits, then escalates SIGTERM/SIGKILL.                                  |
| 30 | ObjectStore        | Object storage     | S3 PUT/GET signed with aws4fetch, or local temp-file + rename publication.                                                      |
| 31 | Logger + EventSink | JSONL directories  | Batched append writes with per-role/date/hour/pid/sequence file names.                                                          |

## Runtime notes

- Layer acquisition is Config -> logging -> shutdown marker -> IdGen -> ObjectStore/AppRegistry -> AppServices
  -> ReaderClient; the program then starts the backup fiber and HTTP listener. Shutdown reverses this: HTTP
  drain, backup fiber, reader, DB handles, final lifecycle event, log drain. `Layer.provideMerge` enforces the
  dependency chain; normal layer-reference memoization shares services. There is no explicit `Layer.memoize`
  call.
- Pure dependencies in `core/` provide schema validation, plan normalization, SQL compilation/decoding,
  errors, events, IPC framing and rotation policy. Tags are declared in `platform/services.ts`, except
  `AppServices` in `platform/registry.ts`. These are module dependencies, not another layer service.
- Routes: `GET /health`, `POST /apps/:appId/:kind/:name`, `POST /admin/backup/:appId`,
  `POST /admin/logs/ingest`, `POST /admin/logs/analysis/:name`. Default body cap: 64 KiB. Conflict is 409,
  queue full is 503, body too large is 413; `core/errors.ts:toHttpStatus` maps typed failures.
- The reader stub yields `IngestError` (500) and `UnknownAnalysisQuery` (404). Its runtime logging root does
  not include `EventLogIngestLive`, regardless of the type alias in `platform/layers.ts`.
- The item-24 retention implementation in `platform/logging/retention.ts` is **not mounted** by this
  composition, so it is not drawn as an active server component. Items 30 and 35 are omitted.
- HTTP request trace annotations do not propagate over the current RPC frame. Reader-side events cannot be
  assumed to carry the HTTP trace ID. The IPC client also emits events under its own connection ID.
- `tests/unit/http_test.ts` exercises the router over in-memory services; components and TypeScript modules
  are distinguished here because the router and lifecycle program are not `Context.Tag`s.
