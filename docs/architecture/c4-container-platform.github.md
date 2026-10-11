# Container — request path

Audited against landed main `643b706` on 2026-10-11 (item 27). Both formats are generated from
`diagrams/c4-container-platform.py`; numbered relationships are identical. All boxes describe landed code.

```mermaid
flowchart TB
    subgraph platform["Platform host and central registry"]
        server["Server process<br/>[Deno process]<br/>platform/server.ts<br/>HTTP auth, SQLite writes, backup and ingest timers"]
        reader["Reader process<br/>[Deno child process]<br/>platform/reader.ts<br/>DuckDB SQLite reads; ingest and named analysis"]
        files["Application documents<br/>[SQLite 3 WAL files]<br/>DATA_DIR; TENANTS_DIR<br/>Legacy app.sqlite; TENANTS_DIR/tenantId.db; one file per tenant"]
        pg["Central registry<br/>[Postgres 17 process/store]<br/>docker-compose.yml; platform/tenants/<br/>Tenants, hashed keys, users, sessions, memberships"]
        tenants["Tenant/auth CLI<br/>[Deno process]<br/>scripts/tenants.ts; scripts/auth.ts<br/>Tenant administration and headless email/password"]
        migration["Migration runner<br/>[Deno process]<br/>scripts/db/migrate.ts<br/>Journaled, advisory-locked SQL migrations"]
    end
        client["Typed client SDK<br/>[Library in caller process]<br/>sdk/client.ts<br/>Named handlers, bearer, X-Trace-Id"]
        objects["Object storage<br/>[External system / filesystem]<br/>S3_BASE_URL or LOCAL_OBJECT_DIR<br/>apps/appId/ snapshots and manifests"]
    client -->|"(1) HTTP JSON + bearer + trace"| server
    server -->|"(2) JSONL IPC query/ping/ingest/analysis; trusted tenant id/path"| reader
    server -->|"(3) node:sqlite; serialized mutation transaction"| files
    reader -->|"(4) DuckDB SQLite extension; READ_ONLY attachment"| files
    server -->|"(5) Postgres protocol; registry SQL and session auth"| pg
    tenants -->|"(6) Postgres protocol; tenant/key or auth operations"| pg
    migration -->|"(7) Postgres protocol; journal and migration SQL"| pg
    server -->|"(8) Snapshot verification/hash; S3 HTTPS or local publication"| objects
    classDef planned stroke-dasharray: 5 3
    classDef person fill:#fff,stroke-width:2px
    classDef external fill:#f4f4f4
    class client external
    class objects external
```

## Relationships

| # | From             | To                    | Relationship                                                 |
| - | ---------------- | --------------------- | ------------------------------------------------------------ |
| 1 | Typed client SDK | Server process        | HTTP JSON + bearer + trace                                   |
| 2 | Server process   | Reader process        | JSONL IPC query/ping/ingest/analysis; trusted tenant id/path |
| 3 | Server process   | Application documents | node:sqlite; serialized mutation transaction                 |
| 4 | Reader process   | Application documents | DuckDB SQLite extension; READ_ONLY attachment                |
| 5 | Server process   | Central registry      | Postgres protocol; registry SQL and session auth             |
| 6 | Tenant/auth CLI  | Central registry      | Postgres protocol; tenant/key or auth operations             |
| 7 | Migration runner | Central registry      | Postgres protocol; journal and migration SQL                 |
| 8 | Server process   | Object storage        | Snapshot verification/hash; S3 HTTPS or local publication    |

## Runtime notes

The writer and reader remain separate OS processes and native module graphs. The central Postgres connection
is acquired lazily for registry use; TENANCY=off preserves app tokens and legacy files. Each app has a
LocalFolderRouter over the shared TENANTS_DIR/tenantId.db path. Different physical layouts need distinct
tenants because the schema guard rejects switching layouts. Tenant-mode reads acquire a fresh scoped reader
per request; legacy reads use the app pool. Application documents stay in SQLite. Better Auth is mounted in
the server at /api/auth/*; scripts/auth.ts is the headless CLI. The future control-plane router is not
implemented. E2E uses ephemeral Postgres, distinct tenants for layouts, and fresh Better Auth servers per
layout.
