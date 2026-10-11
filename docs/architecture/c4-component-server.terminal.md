# Component — server process

Audited against landed main `643b706` on 2026-10-11 (item 27). Both formats are generated from
`diagrams/c4-component-server.py`; numbered relationships are identical. All boxes describe landed code.

<!-- c4-render: diagrams/c4-component-server.py -->

```text
╭╌ Server process: PlatformLive ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ HTTP API / auth              │   │ Server lifecycle             │ ╎
╎  │ [Component]                  │   │ [Component]                  │ ╎
╎  │ platform/http/;              │   │ platform/server.ts           │ ╎
╎  │ platform/auth/               │   │ Scoped listener, backup and  │ ╎
╎  │ Named routes, traces,        │   │ ingest timers, reader-exit   │ ╎
╎  │ tenant/API-key/session       │   │ watch                        │ ╎
╎  │ authentication               │   └──────────────────────────────┘ ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ AppRegistry / AppServices    │   │ TenantRegistry               │ ╎
╎  │ [Effect services]            │   │ [Effect service]             │ ╎
╎  │ platform/registry.ts;        │   │ platform/tenants/store.ts    │ ╎
╎  │ platform/layers.ts           │   │ Lazy Postgres registry;      │ ╎
╎  │ App schema/handlers; Storage │   │ bounded hashed-key TTL cache │ ╎
╎  │ and Backups stack per app    │   └──────────────────────────────┘ ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ TenantStorageRouter          │   │ TenantContext                │ ╎
╎  │ [Effect service]             │   │ [Request-local Effect        │ ╎
╎  │ platform/tenants/routing.ts  │   │ service]                     │ ╎
╎  │ LocalFolderRouter per app;   │   │ platform/tenants/routing.ts  │ ╎
╎  │ validated locations          │   │ Trusted credential-derived   │ ╎
╎  └──────────────────────────────┘   │ tenant id; scoped            │ ╎
╎                                     │ continuation                 │ ╎
╎                                     └──────────────────────────────┘ ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ Storage                      │   │ Backups / ObjectStore        │ ╎
╎  │ [Effect service]             │   │ [Effect services]            │ ╎
╎  │ platform/sqlite.ts           │   │ platform/backup.ts;          │ ╎
╎  │ Scoped handles;              │   │ platform/object_store.ts     │ ╎
╎  │ serialization; rollback and  │   │ Snapshot/hash/manifest;      │ ╎
╎  │ context expiry               │   │ local or signed S3           │ ╎
╎  └──────────────────────────────┘   └──────────────────────────────┘ ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ ReaderClient / ReaderProcess │   │ DocumentReaderClient         │ ╎
╎  │ [Effect services]            │   │ [Effect service]             │ ╎
╎  │ platform/ipc.ts;             │   │ platform/document_reader.ts  │ ╎
╎  │ platform/layers.ts           │   │ In-process SQLite queries;   │ ╎
╎  │ Scoped child for             │   │ read-only connection;        │ ╎
╎  │ ingest/analysis; capped      │   │ concurrency cap 32           │ ╎
╎  │ queue, deadline, trace       │   └──────────────────────────────┘ ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ Logger / EventSink           │   │ Config / IdGen               │ ╎
╎  │ [Effect logger/service]      │   │ [Effect services]            │ ╎
╎  │ platform/logging/            │   │ platform/config.ts;          │ ╎
╎  │ Dropping queue; batched      │   │ platform/sqlite.ts           │ ╎
╎  │ JSONL; final drain           │   │ Validated options; UUIDs;    │ ╎
╎  └──────────────────────────────┘   │ Effect runtime Clock         │ ╎
╎                                     └──────────────────────────────┘ ╎
╎                                                                      ╎
╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯

   ┌──────────────────────────────┐   ┌──────────────────────────────┐
   │ Central registry             │   │ Application files            │
   │ [Postgres process/store]     │   │ [SQLite 3 WAL]               │
   │ DATABASE_URL                 │   │ DATA_DIR; TENANTS_DIR        │
   │ Tenant/key and headless auth │   │ Legacy app files or tenant   │
   │ data                         │   │ locations                    │
   └──────────────────────────────┘   └──────────────────────────────┘

   ┌──────────────────────────────┐   ┌──────────────────────────────┐
   │ Reader child                 │   │ Object storage               │
   │ [Deno process]               │   │ [External system /           │
   │ platform/reader.ts           │   │ filesystem]                  │
   │ DuckDB event-log ingest and  │   │ S3_BASE_URL or               │
   │ named analysis               │   │ LOCAL_OBJECT_DIR             │
   └──────────────────────────────┘   │ Snapshot and manifest        │
                                      │ objects                      │
                                      └──────────────────────────────┘

   ┌──────────────────────────────┐
   │ Server JSONL                 │
   │ [Filesystem]                 │
   │ LOG_DIR/server/date/         │
   │ Durable structured records   │
   └──────────────────────────────┘
```

## Relationships

| #  | From                         | To                           | Relationship                                                   |
| -- | ---------------------------- | ---------------------------- | -------------------------------------------------------------- |
| 1  | HTTP API / auth              | AppRegistry / AppServices    | Resolve app and named handler                                  |
| 2  | HTTP API / auth              | TenantRegistry               | Resolve hashed credentials; admin tenant/key CRUD              |
| 3  | HTTP API / auth              | Central registry             | Better Auth session/registration SQL                           |
| 4  | HTTP API / auth              | TenantContext                | Provide authenticated tenant per request                       |
| 5  | TenantContext                | Storage                      | Resolve tenant writer; never use caller selectors              |
| 6  | AppRegistry / AppServices    | TenantStorageRouter          | Build per-app LocalFolderRouter                                |
| 7  | TenantStorageRouter          | Application files            | Prepare validated SQLite capability and schema                 |
| 8  | Storage                      | TenantStorageRouter          | Resolve/prepare tenant location before opening a cached writer |
| 9  | HTTP API / auth              | Storage                      | Mutation Effect inside serialized transaction                  |
| 10 | HTTP API / auth              | DocumentReaderClient         | Document query in-process; compiled SQLite SQL                 |
| 11 | DocumentReaderClient         | AppRegistry / AppServices    | Resolve registered query, schema and file                      |
| 12 | DocumentReaderClient         | Application files            | node:sqlite read-only connection and transaction               |
| 13 | HTTP API / auth              | ReaderClient / ReaderProcess | Ingest/analysis RPC; trace context                             |
| 14 | Storage                      | Application files            | node:sqlite transaction and snapshot reads                     |
| 15 | Server lifecycle             | Backups / ObjectStore        | Scoped backup timer                                            |
| 16 | Backups / ObjectStore        | Storage                      | Consistent VACUUM INTO snapshot                                |
| 17 | Backups / ObjectStore        | Object storage               | Verified snapshot and manifest publication                     |
| 18 | TenantRegistry               | Central registry             | Parameterized registry SQL; lazy scoped pool                   |
| 19 | Server lifecycle             | ReaderClient / ReaderProcess | Ping; hourly ingest; reader-exit watch and finalizer           |
| 20 | ReaderClient / ReaderProcess | Reader child                 | JSONL RPC; scoped child shutdown                               |
| 21 | Storage                      | Logger / EventSink           | SQL/tx/queue events                                            |
| 22 | HTTP API / auth              | Logger / EventSink           | HTTP/handler spans and failures                                |
| 23 | Server lifecycle             | Logger / EventSink           | Startup/shutdown and timer events                              |
| 24 | Backups / ObjectStore        | Logger / EventSink           | Backup and object-transfer events                              |
| 25 | Logger / EventSink           | Server JSONL                 | Batched append; rotation and scope drain                       |
| 26 | Config / IdGen               | AppRegistry / AppServices    | App schemas, tokens and paths; generated ids                   |
| 27 | Config / IdGen               | TenantRegistry               | DATABASE_URL and scope-owned cache                             |
| 28 | Config / IdGen               | TenantStorageRouter          | TENANTS_DIR and router selection                               |
| 29 | Config / IdGen               | Logger / EventSink           | Level, queue, flush and rotation settings                      |

## Runtime notes

Config is acquired before logging, then IdGen, ObjectStore/AppRegistry, TenantRegistry, AppServices and
ReaderClient. Shutdown drains HTTP, stops timers, closes reader and DB handles, emits the final lifecycle
event, then drains logging. Every partial startup releases acquired resources. Auth derives TenantContext
before consuming app arguments; the tenant SQLite location is prepared behind a shared initialization barrier.
Tenant key revocation invalidates the local cache; other instances converge within its TTL. Tenant-mode
writers use a bounded scope-owned handle cache (default 64 handles, 60-second idle expiry); requests lease
handles, and shutdown drains leases before closing them. Retention and named analysis execute in the reader,
never as server-side DuckDB components. Item 26 removes compatibility wrappers and platform/compiler.ts; pure
compilation now lives in core/compile/ and introduces no new runtime component. HTTP status mapping lives in
core/errors.ts. Better Auth connections are bounded to each request/CLI operation, separate from the lazy
registry pool.
