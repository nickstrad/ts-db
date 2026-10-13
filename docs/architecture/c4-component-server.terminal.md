# Component — server process

Audited against landed main `643b706` on 2026-10-11 (item 27); updated for FFI-01 to FFI-04 at `51a5283` on
2026-10-13. Both formats are generated from `diagrams/c4-component-server.py`; numbered relationships are
identical. All boxes describe landed code.

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
╎  │ FFI SQLite binding           │   │ Logger / EventSink           │ ╎
╎  │ [Library in server process]  │   │ [Effect logger/service]      │ ╎
╎  │ platform/sqlite_ffi/         │   │ platform/logging/            │ ╎
╎  │ System libsqlite3 via        │   │ Dropping queue; batched      │ ╎
╎  │ Deno.dlopen; every server    │   │ JSONL; final drain           │ ╎
╎  │ SQLite open goes through it  │   └──────────────────────────────┘ ╎
╎  │ (FFI-04), node:sqlite is not │                                    ╎
╎  │ loaded. Blocking path with   │                                    ╎
╎  │ 64-statement cache in use;   │                                    ╎
╎  │ interruptible async API and  │                                    ╎
╎  │ statement deadline not used  │                                    ╎
╎  │ yet                          │                                    ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐                                    ╎
╎  │ Config / IdGen               │                                    ╎
╎  │ [Effect services]            │                                    ╎
╎  │ platform/config.ts;          │                                    ╎
╎  │ platform/sqlite.ts           │                                    ╎
╎  │ Validated options            │                                    ╎
╎  │ (sqlite.library read by      │                                    ╎
╎  │ every open; statement        │                                    ╎
╎  │ deadline and grace parsed    │                                    ╎
╎  │ but unread); UUIDs; Clock    │                                    ╎
╎  └──────────────────────────────┘                                    ╎
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

| #  | From                         | To                           | Relationship                                                                           |
| -- | ---------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| 1  | HTTP API / auth              | AppRegistry / AppServices    | Resolve app and named handler                                                          |
| 2  | HTTP API / auth              | TenantRegistry               | Resolve hashed credentials; admin tenant/key CRUD                                      |
| 3  | HTTP API / auth              | Central registry             | Better Auth session/registration SQL                                                   |
| 4  | HTTP API / auth              | TenantContext                | Provide authenticated tenant per request                                               |
| 5  | TenantContext                | Storage                      | Resolve tenant writer; never use caller selectors                                      |
| 6  | AppRegistry / AppServices    | TenantStorageRouter          | Build per-app LocalFolderRouter                                                        |
| 7  | TenantStorageRouter          | FFI SQLite binding           | Open and prepare validated tenant SQLite file; schema guard                            |
| 8  | Storage                      | TenantStorageRouter          | Resolve/prepare tenant location before opening a cached writer                         |
| 9  | HTTP API / auth              | Storage                      | Mutation Effect inside serialized transaction                                          |
| 10 | HTTP API / auth              | DocumentReaderClient         | Document query in-process; compiled SQLite SQL                                         |
| 11 | DocumentReaderClient         | AppRegistry / AppServices    | Resolve registered query, schema and file                                              |
| 12 | DocumentReaderClient         | FFI SQLite binding           | Read-only connection and transaction; prepared-statement cache                         |
| 13 | HTTP API / auth              | ReaderClient / ReaderProcess | Ingest/analysis RPC; trace context                                                     |
| 14 | Storage                      | FFI SQLite binding           | Writer connection, transactions and snapshot reads; blocking path                      |
| 15 | Server lifecycle             | Backups / ObjectStore        | Scoped backup timer                                                                    |
| 16 | Backups / ObjectStore        | Storage                      | Consistent VACUUM INTO snapshot                                                        |
| 17 | Backups / ObjectStore        | FFI SQLite binding           | Read-only quick_check of the snapshot copy before publication                          |
| 18 | Backups / ObjectStore        | Object storage               | Verified snapshot and manifest publication                                             |
| 19 | TenantRegistry               | Central registry             | Parameterized registry SQL; lazy scoped pool                                           |
| 20 | Server lifecycle             | ReaderClient / ReaderProcess | Ping; hourly ingest; reader-exit watch and finalizer                                   |
| 21 | ReaderClient / ReaderProcess | Reader child                 | JSONL RPC; scoped child shutdown                                                       |
| 22 | Storage                      | Logger / EventSink           | SQL/tx/queue events                                                                    |
| 23 | HTTP API / auth              | Logger / EventSink           | HTTP/handler spans and failures                                                        |
| 24 | Server lifecycle             | Logger / EventSink           | Startup/shutdown and timer events                                                      |
| 25 | Backups / ObjectStore        | Logger / EventSink           | Backup and object-transfer events                                                      |
| 26 | Logger / EventSink           | Server JSONL                 | Batched append; rotation and scope drain                                               |
| 27 | Config / IdGen               | AppRegistry / AppServices    | App schemas, tokens and paths; generated ids                                           |
| 28 | Config / IdGen               | TenantRegistry               | DATABASE_URL and scope-owned cache                                                     |
| 29 | Config / IdGen               | TenantStorageRouter          | TENANTS_DIR and router selection                                                       |
| 30 | Config / IdGen               | Logger / EventSink           | Level, queue, flush and rotation settings                                              |
| 31 | Config / IdGen               | FFI SQLite binding           | sqlite.library: the libsqlite3 path passed to every open                               |
| 32 | AppRegistry / AppServices    | FFI SQLite binding           | Load libsqlite3 once at startup; sqlite-library lifecycle event names path and version |
| 33 | FFI SQLite binding           | Application files            | libsqlite3 file I/O; WAL transactions and read-only snapshots                          |

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
registry pool. FFI-04: Storage, DocumentReaderClient, TenantStorageRouter and the backup verifier open SQLite
only through the FFI binding, on Config.sqlite.library; node:sqlite is not in the server runtime graph
(tests/unit/boundaries_test.ts). Startup loads libsqlite3 once and logs a lifecycle event, phase
sqlite-library, with the resolved path and version.
