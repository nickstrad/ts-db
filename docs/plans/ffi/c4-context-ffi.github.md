# System Context — FFI execution layer and tenant cells

Proposed design, not landed code: the FFI execution layer from
[lang-switch-fable.md](../../architecture/lang-switch-fable.md) combined with the scale-out pick F from
[scale-out-final-fable.md](../../architecture/scale-out-final-fable.md). Baseline `main` at `e808983`
(2026-10-12). Solid boxes and solid edges exist on `main`; dashed boxes and dashed edges marked **(planned)**
do not. Both formats are generated from `diagrams/c4-context-ffi.py`; numbered relationships are identical.

```mermaid
flowchart TB
    subgraph platform["Document DB platform"]
        db["Document DB platform<br/>[Software system]<br/>platform/<br/>Deno API nodes; statement lanes with FFI to libsqlite3 (planned); DuckDB event-log child"]
        registry["Central registry and placement<br/>[Software system, part of the platform]<br/>platform/tenants/; placement table (planned)<br/>Postgres: tenants, hashed keys, sessions; tenant-to-node placement with leases and epochs (planned)"]
    end
        developer["App developer<br/>[Person]<br/>app/; sdk/<br/>Declares schemas and Effect handlers"]
        caller["Application caller<br/>[Person]<br/>sdk/client.ts<br/>Players and authenticated tenant users"]
        operator["Platform operator<br/>[Person]<br/>scripts/<br/>Tenants, auth, backups; placement moves (planned)"]
        objects["Object storage<br/>[External system]<br/>S3_BASE_URL or LOCAL_OBJECT_DIR<br/>Immutable snapshots and manifests; WAL frames (planned, phase two)"]
        analytics["Analytics consumer<br/>[External system]<br/>scripts/logs.ts; scripts/duckdb/<br/>Named catalog or offline SQL"]
    developer -->|"(1) Schema and named handlers (TypeScript)"| db
    caller -->|"(2) HTTP JSON; bearer credentials; X-Trace-Id; served by the owning node or forwarded"| db
    operator -->|"(3) Admin HTTP / CLI; tenant, backup and placement-move operations"| db
    db -->|"(4) Postgres protocol; auth and tenant SQL; placement lookup and lease heartbeat"| registry
    db -->|"(5) S3 HTTPS or local files; snapshots and manifests; WAL frames"| objects
    db -->|"(6) Query results; derived event-log rows"| analytics
    classDef planned stroke-dasharray: 5 3
    classDef person fill:#fff,stroke-width:2px
    classDef external fill:#f4f4f4
    class developer person
    class caller person
    class operator person
    class objects external
    class analytics external
```

## Relationships

| # | From                 | To                             | Relationship                                                                      |
| - | -------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| 1 | App developer        | Document DB platform           | Schema and named handlers (TypeScript)                                            |
| 2 | Application caller   | Document DB platform           | HTTP JSON; bearer credentials; X-Trace-Id; served by the owning node or forwarded |
| 3 | Platform operator    | Document DB platform           | Admin HTTP / CLI; tenant, backup and placement-move operations                    |
| 4 | Document DB platform | Central registry and placement | Postgres protocol; auth and tenant SQL; placement lookup and lease heartbeat      |
| 5 | Document DB platform | Object storage                 | S3 HTTPS or local files; snapshots and manifests; WAL frames                      |
| 6 | Document DB platform | Analytics consumer             | Query results; derived event-log rows                                             |

## Runtime notes

What exists on `main`: one API node holding every SQLite handle through `node:sqlite`, the Postgres registry
for tenants, keys and sessions, the DuckDB reader child, snapshot backups to object storage. What is planned,
inside the same system boundary: statement lanes (child processes) that execute SQLite through Deno FFI to the
system `libsqlite3`, a placement table in the existing Postgres so any node can forward a request to the
tenant's owner, and WAL frames shipped to object storage after the snapshot path. No new external system is
introduced: the forwarded hop is node-to-node inside the platform, and the caller contract
(`createClient(baseURL, appId, token)`) is unchanged. k6 and the migration/tenant CLIs are unchanged and
omitted here for focus; see `docs/architecture/c4-context-document-db.github.md` for the audited landed
context.
