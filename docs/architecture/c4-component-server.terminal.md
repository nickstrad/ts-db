# C4 Level 3 — Component: inside the server process

Renderings: [GitHub](c4-component-server.github.md) · [terminal](c4-component-server.terminal.md).

## What this shows

The live server composition is `PlatformLive` in `platform/layers.ts` (item 22), driven by `makeServer` in
`platform/server.ts` (item 32). The HTTP router resolves per-app stacks through `AppServices`; it is not
provided a single global `Storage`. All components shown inside the boundary are implemented and mounted. The
reader and persistent stores are boundary elements; the reader's own composition is described in the
[observability diagram](c4-container-observability.github.md). The pure kernel and service tags are
compile-time modules used by these components, not runtime services.

Current state at the audited commit (see [`README.md`](README.md#audited-state)): the server reaches the event
log only through the reader's `ingest` RPC, and it carries the caller's trace to the reader (item 34). Item
23's catalog and CLI are not drawn because they do not exist.

<!-- c4-render: diagrams/c4-component-server.py -->

```text
╭╌ Server process - PlatformLive (items 22, 32) ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ HTTP API                     │   │ Server lifecycle             │ ╎
╎  │ [Component] (items 22, 34)   │   │ [Component] (items 22, 32)   │ ╎
╎  │ platform/http/               │   │ platform/server.ts           │ ╎
╎  │ router.ts, auth.ts,          │   │ Scoped HTTP listener; backup │ ╎
╎  │ handlers.ts                  │   │ and ingest-sweep             │ ╎
╎  │ Bearer auth; body cap;       │   │ timers; reader-exit watch;   │ ╎
╎  │ X-Trace-Id ingress;          │   │ signals                      │ ╎
╎  │ handler spans (item 34);     │   └──────────────────────────────┘ ╎
╎  │ typed errors                 │                                    ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ AppServices                  │   │ AppRegistry                  │ ╎
╎  │ [Effect service] (item 22)   │   │ [Effect service] (item 22)   │ ╎
╎  │ platform/registry.ts         │   │ platform/registry.ts         │ ╎
╎  │ AppServicesLive:             │   │ Config apps -> schema,       │ ╎
╎  │ platform/layers.ts           │   │ handlers, token, SQLite path │ ╎
╎  │ One Storage + Backups stack  │   └──────────────────────────────┘ ╎
╎  │ per app                      │                                    ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ Storage                      │   │ Backups                      │ ╎
╎  │ [Effect service] (item 15)   │   │ [Effect service] (item 19)   │ ╎
╎  │ platform/sqlite.ts           │   │ platform/backup.ts           │ ╎
╎  │ Per-app scoped SQLite        │   │ Per-app snapshot,            │ ╎
╎  │ handle; serialized           │   │ verification, hash and       │ ╎
╎  │ mutation/snapshot queue      │   │ publication                  │ ╎
╎  └──────────────────────────────┘   └──────────────────────────────┘ ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ ReaderClient                 │   │ ObjectStore                  │ ╎
╎  │ [Effect service] (items 17,  │   │ [Effect service] (item 18)   │ ╎
╎  │ 34)                          │   │ platform/object_store.ts     │ ╎
╎  │ platform/ipc.ts              │   │ Local files or signed S3;    │ ╎
╎  │ Scoped child; Deferred       │   │ transient S3 retries         │ ╎
╎  │ replies; queue cap           │   └──────────────────────────────┘ ╎
╎  │ and deadline; caller trace   │                                    ╎
╎  │ captured per call            │                                    ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ Logger + EventSink           │   │ Config                       │ ╎
╎  │ [Effect logger/service] (11) │   │ [Effect service] (item 08)   │ ╎
╎  │ platform/logging/            │   │ platform/config.ts           │ ╎
╎  │ logger.ts, file_sink.ts      │   │ Validated environment        │ ╎
╎  │ Dropping queue; JSONL        │   │ options; startup failure on  │ ╎
╎  │ batches; scope finalizer     │   │ invalid config               │ ╎
╎  │ drains                       │   └──────────────────────────────┘ ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐                                    ╎
╎  │ IdGen                        │                                    ╎
╎  │ [Effect service]             │                                    ╎
╎  │ platform/sqlite.ts           │                                    ╎
╎  │ IdGenLive: random UUIDs      │                                    ╎
╎  │ Clock: Effect runtime        │                                    ╎
╎  │ service                      │                                    ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯

   ┌──────────────────────────────┐   ┌──────────────────────────────┐
   │ Reader process               │   │ App SQLite files             │
   │ [Deno child process]         │   │ [SQLite 3, WAL]              │
   │ platform/reader.ts           │   │ <DATA_DIR>/<appId>.sqlite    │
   │ Root:                        │   └──────────────────────────────┘
   │ platform/reader_layers.ts    │
   │ (item 33)                    │
   └──────────────────────────────┘

   ┌──────────────────────────────┐   ┌──────────────────────────────┐
   │ Object storage               │   │ JSONL directories            │
   │ [External system/filesystem] │   │ [filesystem]                 │
   │ S3_BASE_URL or               │   │ <LOG_DIR>/server/<date>/     │
   │ OBJECT_STORE_DIR             │   └──────────────────────────────┘
   │ apps/<appId>/                │
   └──────────────────────────────┘
```

## Relationships

All arrows are listed here in both formats. The terminal uses this key instead of crossing lines.

| #  | From               | To                 | Relationship                                                                                                                                                                                      |
| -- | ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Server lifecycle   | HTTP API           | `Deno.serve` invokes the router on the Effect runtime; shutdown drains requests before closing dependencies.                                                                                      |
| 2  | HTTP API           | AppServices        | Mutation and admin-backup handlers resolve `AppServices.get(appId)`, then call the stack storage or backups.                                                                                      |
| 3  | Server lifecycle   | AppServices        | A scoped `Schedule.spaced` fiber enumerates app stacks and calls backups sequentially. Disabled when `BACKUP_INTERVAL_MS=0`.                                                                      |
| 4  | AppServices        | AppRegistry        | `AppServicesLive` enumerates `AppRegistry.all` while building per-app stacks.                                                                                                                     |
| 5  | AppServices        | Storage            | One scoped writer per registered app, shared with that app's backups.                                                                                                                             |
| 6  | AppServices        | Backups            | `BackupsLive` is provided the matching `StorageLive`.                                                                                                                                             |
| 7  | HTTP API           | AppRegistry        | Health lists registered apps and pings the reader.                                                                                                                                                |
| 8  | HTTP API           | ReaderClient       | JSON RPC: `query`, `ping`, and `ingest` (the reader's ingest-then-sweep). `analysis` returns `UnknownAnalysisQuery` (404) until item 23. A reader exit, timeout or protocol failure is HTTP 502.  |
| 9  | Backups            | Storage            | `VACUUM INTO` serializes with mutations; verification and upload run after releasing the writer queue.                                                                                            |
| 10 | Backups            | ObjectStore        | Snapshot -> quick_check -> SHA-256 -> immutable object -> manifest -> latest.json. Failure cannot publish latest early.                                                                           |
| 11 | HTTP API           | Logger + EventSink | One `http` record per request, plus a `handler` record for app invocations (ok, typed failure, defect or interruption); trace ID echoed in the response. Each handler runs as a child span.       |
| 12 | Server lifecycle   | Logger + EventSink | Startup, stopping, HTTP drain and shutdown events. Shutdown marker runs before final log drain.                                                                                                   |
| 13 | Storage            | Logger + EventSink | SQL tracing honors configuration; failed statements and transaction outcomes are recorded, carrying the handler's `traceId` and `spanId`.                                                         |
| 14 | ReaderClient       | Logger + EventSink | Queue and anomaly records. A call's events carry the trace captured at submission; connection-level events and untraced calls use the connection's `reader-client-<uuid>` trace.                  |
| 15 | Backups            | Logger + EventSink | Snapshot, verify, hash, put-manifest and publish-latest events; snapshot object PUT is normally recorded by ObjectStore.                                                                          |
| 16 | ObjectStore        | Logger + EventSink | PUT emits backup/put-object; GET emits lifecycle records, with outcome and duration.                                                                                                              |
| 17 | Config             | HTTP API           | The HTTP components consume the validated admin token and body-size limit.                                                                                                                        |
| 18 | Config             | Server lifecycle   | Bind host, port, backup interval and startup token warnings.                                                                                                                                      |
| 19 | Config             | AppRegistry        | App IDs, layouts, tokens and data directory.                                                                                                                                                      |
| 20 | Config             | Storage            | Storage consumes logging configuration; file/schema/appId arrive through AppServicesLive.                                                                                                         |
| 21 | Config             | ReaderClient       | `ReaderClientConfigured` reads `READER_CALL_TIMEOUT_MS` (default 30 seconds).                                                                                                                     |
| 22 | Config             | ObjectStore        | Local directory or S3 endpoint/credentials and signing region.                                                                                                                                    |
| 23 | Config             | Logger + EventSink | Directory, log level, queue capacity and file rotation policy.                                                                                                                                    |
| 24 | IdGen              | HTTP API           | Fallback when the presented X-Trace-Id is absent or invalid.                                                                                                                                      |
| 25 | IdGen              | Storage            | Document/event IDs from IdGen; times from Effect Clock.                                                                                                                                           |
| 26 | IdGen              | Backups            | Backup IDs and events; phase timings use Effect Clock.                                                                                                                                            |
| 27 | IdGen              | ObjectStore        | Temporary object names and operation events.                                                                                                                                                      |
| 28 | Storage            | App SQLite files   | `DatabaseSync`; one BEGIN IMMEDIATE transaction per mutation, including handler reads; scoped rollback on failure/interruption.                                                                   |
| 29 | ReaderClient       | Reader process     | Child in its own process group; finalizer closes stdin, waits, then escalates SIGTERM/SIGKILL. A frame carries `traceId`, `spanId` and `parentSpanId` when the call was made inside a request.    |
| 30 | ObjectStore        | Object storage     | S3 PUT/GET signed with aws4fetch, or local temp-file + rename publication.                                                                                                                        |
| 31 | Logger + EventSink | JSONL directories  | Batched append writes with per-role/date/hour/pid/sequence file names.                                                                                                                            |
| 32 | Server lifecycle   | ReaderClient       | A scoped `Schedule.spaced` fiber sends `ingest` every `INGEST_SWEEP_INTERVAL` (1 hour, first run after one interval). Failures are `ingest-sweep-failed` warnings; the server never opens DuckDB. |
| 33 | Server lifecycle   | ReaderClient       | `ReaderProcess.exited` is raced against the stop signal; a reader exit while serving logs `stopping` (`reader-exited`), shuts down in order and exits 1.                                          |
| 34 | AppServices        | Logger + EventSink | `storage-opened` / `storage-closed` lifecycle records per app (closed only after the handle and writer queue have closed).                                                                        |

## Runtime notes

- Layer acquisition is Config -> logging -> shutdown marker -> IdGen -> ObjectStore/AppRegistry -> AppServices
  -> ReaderClient (plus `ReaderProcess`); the program then pings the reader, starts the ingest-then-sweep
  fiber and the backup fiber, and binds the HTTP listener. Shutdown reverses this: HTTP drain, backup fiber,
  ingest-sweep fiber, reader, DB handles, final `lifecycle` event, log drain. `Layer.provideMerge` enforces
  the dependency chain; normal layer-reference memoization shares services. There is no explicit
  `Layer.memoize` call. A failure at any startup step releases everything acquired before it; an HTTP bind
  failure is a typed `ListenError`.
- Pure dependencies in `core/` provide schema validation, plan normalization, SQL compilation/decoding,
  errors, events, IPC framing and rotation policy. Tags are declared in `platform/services.ts`, except
  `AppServices` in `platform/registry.ts`. These are module dependencies, not another layer service.
- Routes: `GET /health`, `POST /apps/:appId/:kind/:name`, `POST /admin/backup/:appId`,
  `POST /admin/logs/ingest`, `POST /admin/logs/analysis/:name`. Default body cap: 64 KiB. Conflict is 409,
  queue full is 503, body too large is 413, a reader failure is 502; `core/errors.ts:toHttpStatus` maps typed
  failures.
- `POST /admin/logs/ingest` is answered by the reader's ingest-then-sweep coordinator (ADR 0007); an
  unopenable or incompatible event-log file is a typed `IngestError` (500) and does not stop queries.
  `POST /admin/logs/analysis/:name` returns `UnknownAnalysisQuery` (404) after auth and input validation.
- The server process never imports `@duckdb/node-api` or the reader's root; `platform/layers.ts` imports
  `platform/eventlog/*` as types only. `tests/unit/server_scope_test.ts` inspects the server import graph.
- Retention (`platform/logging/retention.ts`) is not a server component: no server fiber sweeps files. It runs
  only inside the reader's `ingest` RPC, because only the reader can read the ingest watermarks.
- Trace context: ingress validates `X-Trace-Id` (1-128 of `[A-Za-z0-9._:-]`, otherwise generated, always
  echoed); each handler is a child span; `ReaderClient` captures the trace when a call is submitted and the
  frame carries it to the reader. The ingest timer and startup ping run outside any trace and send legacy
  frames. `tests/unit/trace_e2e_test.ts` covers the real SDK, server and reader child.
- Item 31 (U+0000 rejection) and item 30 (json-layout REAL cast) live in `Storage` and the compiler, so they
  change behavior inside components already drawn rather than adding a component.
- `tests/unit/http_test.ts` exercises the router over in-memory services; components and TypeScript modules
  are distinguished here because the router and lifecycle program are not `Context.Tag`s.
