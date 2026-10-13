# Container — request path

Audited against landed main `643b706` on 2026-10-11 (item 27); re-checked for FFI-01 and FFI-02 at `398be14`
on 2026-10-13. Both formats are generated from `diagrams/c4-container-platform.py`; numbered relationships are
identical. All boxes describe landed code.

<!-- c4-render: diagrams/c4-container-platform.py -->

```text
╭╌ Platform host and central registry ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮
╎                                                                      ╎
╎  ┌──────────────────────────────┐   ┌──────────────────────────────┐ ╎
╎  │ Server process               │   │ Reader process               │ ╎
╎  │ [Deno process]               │   │ [Deno child process]         │ ╎
╎  │ platform/server.ts           │   │ platform/reader.ts           │ ╎
╎  │ HTTP auth, SQLite document   │   │ Event-log DuckDB; ingest and │ ╎
╎  │ reads/writes, backup and     │   │ named analysis               │ ╎
╎  │ ingest timers                │   └──────────────────────────────┘ ╎
╎  └──────────────────────────────┘                                    ╎
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
╎  │ Tenant/auth CLI              │   │ Migration runner             │ ╎
╎  │ [Deno process]               │   │ [Deno process]               │ ╎
╎  │ scripts/tenants.ts;          │   │ scripts/db/migrate.ts        │ ╎
╎  │ scripts/auth.ts              │   │ Journaled, advisory-locked   │ ╎
╎  │ Tenant administration and    │   │ SQL migrations               │ ╎
╎  │ headless email/password      │   └──────────────────────────────┘ ╎
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

| # | From             | To                    | Relationship                                              |
| - | ---------------- | --------------------- | --------------------------------------------------------- |
| 1 | Typed client SDK | Server process        | HTTP JSON + bearer + trace                                |
| 2 | Server process   | Reader process        | JSONL IPC ping/ingest/analysis                            |
| 3 | Server process   | Application documents | node:sqlite; read-only queries and serialized mutations   |
| 4 | Server process   | Central registry      | Postgres protocol; registry SQL and session auth          |
| 5 | Tenant/auth CLI  | Central registry      | Postgres protocol; tenant/key or auth operations          |
| 6 | Migration runner | Central registry      | Postgres protocol; journal and migration SQL              |
| 7 | Server process   | Object storage        | Snapshot verification/hash; S3 HTTPS or local publication |

## Runtime notes

The writer and reader remain separate OS processes and native module graphs. The central Postgres connection
is acquired lazily for registry use; TENANCY=off preserves app tokens and legacy files. Each app has a
LocalFolderRouter over the shared TENANTS_DIR/tenantId.db path. Different physical layouts need distinct
tenants because the schema guard rejects switching layouts. Document queries use fresh read-only node:sqlite
connections in the server, with authenticated tenant routing selecting the file. Application documents stay in
SQLite. Better Auth is mounted in the server at /api/auth/*; scripts/auth.ts is the headless CLI. The future
control-plane router is not implemented. E2E uses ephemeral Postgres, distinct tenants for layouts, and fresh
Better Auth servers per layout.
