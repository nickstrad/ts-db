# Container — request path

Audited against landed main `cd669d1` on 2026-10-11 (reflection astra-2). Both formats are generated from
`diagrams/c4-container-platform.py`; numbered relationships are identical. All boxes describe landed code.

<!-- c4-render: diagrams/c4-container-platform.py -->

```text
╭╌ Platform host and central registry ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ Server process               │   │ Reader process               │ ╎
╎  │ [Deno process]               │   │ [Deno child process]         │ ╎
╎  │ platform/server.ts           │   │ platform/reader.ts           │ ╎
╎  │ HTTP auth, SQLite writes,    │   │ DuckDB SQLite reads; ingest  │ ╎
╎  │ backup and ingest timers     │   │ and named analysis           │ ╎
╎  └──────────────────────────────┘   └──────────────────────────────┘ ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ Application documents        │   │ Central registry             │ ╎
╎  │ [SQLite 3 WAL files]         │   │ [Postgres 17 process/store]  │ ╎
╎  │ DATA_DIR; TENANTS_DIR        │   │ docker-compose.yml;          │ ╎
╎  │ Legacy app.sqlite;           │   │ platform/tenants/            │ ╎
╎  │ TENANTS_DIR/tenantId.db; one │   │ Tenants, hashed keys, users, │ ╎
╎  │ file per tenant              │   │ sessions, memberships        │ ╎
╎  └──────────────────────────────┘   └──────────────────────────────┘ ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ Tenant CLI                   │   │ Auth CLI                     │ ╎
╎  │ [Deno process]               │   │ [Deno process]               │ ╎
╎  │ scripts/tenants.ts           │   │ scripts/auth.ts              │ ╎
╎  │ Admin HTTP client; explicit  │   │ Headless account creation    │ ╎
╎  │ ADMIN_TOKEN                  │   │ and membership linking       │ ╎
╎  └──────────────────────────────┘   └──────────────────────────────┘ ╎
╎                                                                      ╎
╎  ┌──────────────────────────────┐                                    ╎
╎  │ Migration runner             │                                    ╎
╎  │ [Deno process]               │                                    ╎
╎  │ scripts/db/migrate.ts        │                                    ╎
╎  │ Journaled, advisory-locked   │                                    ╎
╎  │ SQL migrations               │                                    ╎
╎  └──────────────────────────────┘                                    ╎
╎                                                                      ╎
╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯

   ┌──────────────────────────────┐   ┌──────────────────────────────┐
   │ Typed client SDK             │   │ Object storage               │
   │ [Library in caller process]  │   │ [External system /           │
   │ sdk/client.ts                │   │ filesystem]                  │
   │ Named handlers, bearer,      │   │ S3_BASE_URL or               │
   │ X-Trace-Id                   │   │ LOCAL_OBJECT_DIR             │
   └──────────────────────────────┘   │ apps/appId/ snapshots and    │
                                      │ manifests                    │
                                      └──────────────────────────────┘
```

## Relationships

| #  | From             | To                    | Relationship                                                      |
| -- | ---------------- | --------------------- | ----------------------------------------------------------------- |
| 1  | Typed client SDK | Server process        | HTTP JSON + bearer + trace                                        |
| 2  | Server process   | Reader process        | JSONL IPC query/ping/ingest/analysis; trusted tenant id/path      |
| 3  | Server process   | Application documents | node:sqlite; serialized mutation transaction                      |
| 4  | Reader process   | Application documents | DuckDB SQLite extension; READ_ONLY attachment                     |
| 5  | Server process   | Central registry      | Postgres protocol; registry SQL and session auth                  |
| 6  | Tenant CLI       | Server process        | HTTP JSON; ADMIN_TOKEN; tenant/key CRUD                           |
| 7  | Migration runner | Central registry      | Postgres protocol; journal and migration SQL                      |
| 8  | Server process   | Object storage        | Tenancy-off snapshots; S3 HTTPS or local publication              |
| 9  | Auth CLI         | Central registry      | Postgres protocol; auth and membership SQL                        |
| 10 | Server process   | Reader process        | Spawn and ready-ping; restart backoff; stop on breaker exhaustion |

## Runtime notes

The writer and reader remain separate OS processes and native module graphs. The central Postgres connection
is acquired lazily for registry use; TENANCY=off preserves app tokens and legacy files. Each app has a
LocalFolderRouter over the shared TENANTS_DIR/tenantId.db path. Different physical layouts need distinct
tenants because the schema guard rejects switching layouts. Tenant-mode reads acquire a fresh scoped reader
per request; legacy reads use the app pool. Application documents stay in SQLite. Better Auth is mounted in
the server at /api/auth/*; scripts/auth.ts is the headless CLI. The future control-plane router is not
implemented. E2E uses ephemeral Postgres, distinct tenants for layouts, and fresh Better Auth servers per
layout. Tenant CLI calls the admin HTTP API; only the auth CLI and migration runner connect directly to
Postgres. The backup route/timer supplies no TenantContext and therefore fails in tenant modes; app-only
object keys and restore are not a tenant recovery protocol. Reader restarts preserve SQLite files, but queued
reader calls fail with 502 and are never replayed. Five restart attempts per ten minutes are allowed. The E2E
harness (tests/e2e/platform/main.ts and compose.yml) instantiates isolated copies of these containers, never
the dev stack. Its backup scenario uses tenancy-off; it does not prove tenant recovery.
