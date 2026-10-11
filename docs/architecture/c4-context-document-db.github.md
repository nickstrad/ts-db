# System Context

Audited against landed main `643b706` on 2026-10-11 (item 27). Both formats are generated from
`diagrams/c4-context-document-db.py`; numbered relationships are identical. All boxes describe landed code.

```mermaid
flowchart TB
    subgraph platform["Document DB platform"]
        db["Document DB platform<br/>[Software system]<br/>platform/<br/>Effect; SQLite document reads/writes; DuckDB event log and analysis"]
    end
        developer["App developer<br/>[Person]<br/>app/; sdk/<br/>Declares schemas and Effect handlers"]
        caller["Application caller<br/>[Person]<br/>sdk/client.ts<br/>Players and authenticated tenant users"]
        operator["Platform operator<br/>[Person]<br/>scripts/<br/>Tenants, auth, backups and log analysis"]
        objects["Object storage<br/>[External system]<br/>S3_BASE_URL or LOCAL_OBJECT_DIR<br/>Immutable snapshots and manifests"]
        analytics["Analytics consumer<br/>[External system]<br/>scripts/logs.ts; scripts/duckdb/<br/>Named catalog or offline SQL"]
        k6["k6 load generator<br/>[External system]<br/>perf/*.js<br/>HTTP load and raw metric points"]
    developer -->|"(1) Schema and named handlers (TypeScript)"| db
    caller -->|"(2) HTTP JSON; bearer credentials; X-Trace-Id"| db
    operator -->|"(3) Admin HTTP / CLI; tenant and backup operations"| db
    db -->|"(4) S3 HTTPS or local files; snapshots and manifests"| objects
    db -->|"(5) Query results; derived event-log rows"| analytics
    k6 -->|"(6) HTTP scenarios and trace headers"| db
    classDef planned stroke-dasharray: 5 3
    classDef person fill:#fff,stroke-width:2px
    classDef external fill:#f4f4f4
    class developer person
    class caller person
    class operator person
    class objects external
    class analytics external
    class k6 external
```

## Relationships

| # | From                 | To                   | Relationship                                     |
| - | -------------------- | -------------------- | ------------------------------------------------ |
| 1 | App developer        | Document DB platform | Schema and named handlers (TypeScript)           |
| 2 | Application caller   | Document DB platform | HTTP JSON; bearer credentials; X-Trace-Id        |
| 3 | Platform operator    | Document DB platform | Admin HTTP / CLI; tenant and backup operations   |
| 4 | Document DB platform | Object storage       | S3 HTTPS or local files; snapshots and manifests |
| 5 | Document DB platform | Analytics consumer   | Query results; derived event-log rows            |
| 6 | k6 load generator    | Document DB platform | HTTP scenarios and trace headers                 |

## Runtime notes

Tenant identity comes from API keys or headless Better Auth session bearers when enabled. Postgres is part of
the platform, shown at Level 2; no external identity provider is wired. No application SQL crosses the client
boundary. This audit includes items 23, 25, 26 and MT-01 through MT-10.
