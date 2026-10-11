# Architecture diagrams

[C4 model](https://c4model.com/) diagrams for this repo. Every diagram exists in two formats: `*.github.md`
(Mermaid, rendered by GitHub) and `*.terminal.md` (box-drawing, built for `glow`). They are two renderings of
one diagram — same elements, same relationships, same markers.

Conventions, naming and the maintenance contract: [`AGENTS.md`](AGENTS.md).

## Index

| Level | Diagram                        | What it shows                                                                                                                                                                      | GitHub                                         | Terminal                                           |
| ----- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| 1     | System Context                 | The platform as one box: app developers, players, the operator, and the external object store, DuckDB analytics consumer and k6 load generator.                                    | [github](c4-context-document-db.github.md)     | [terminal](c4-context-document-db.terminal.md)     |
| 2     | Container — request path       | The server process, the DuckDB reader child process, the legacy/per-tenant SQLite files, Postgres registry and the object store, and how a request and a backup move between them. | [github](c4-container-platform.github.md)      | [terminal](c4-container-platform.terminal.md)      |
| 2     | Container — observability path | Server/reader JSONL, the reader's connected ingest-then-sweep into the derived DuckDB event log, the reader composition, live named analysis, logs CLI and k6 loader.              | [github](c4-container-observability.github.md) | [terminal](c4-container-observability.terminal.md) |
| 3     | Component — server process     | The mounted HTTP/lifecycle components and services, including per-app AppServices, storage, backups, reader client, logging and dependencies.                                      | [github](c4-component-server.github.md)        | [terminal](c4-component-server.terminal.md)        |

Level 2 is split in two so neither picture is cluttered; together they cover one container set.

## Reading them in a terminal

```sh
glow docs/architecture/c4-context-document-db.terminal.md
glow docs/architecture/c4-container-platform.terminal.md
glow docs/architecture/c4-container-observability.terminal.md
glow docs/architecture/c4-component-server.terminal.md
```

## Audited state

These diagrams describe landed main `643b706`, audited on 2026-10-11 for item 27. The earlier audit at
`e423ed1` covered items 22/24/30–36; this refresh reads the landed changes since that snapshot, including
items 23/25/26 and MT-01 through MT-10. All four pairs change: request/auth context, central Postgres and CLI
containers, tenant components, and connected analysis/k6 observability paths.

| Item        | Landed as         | Diagram impact verified against code/diff                                                                                                                                    |
| ----------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22/24/30–36 | Through `e423ed1` | Existing Effect roots, native process split, trace/event schema v2 and ingest-gated retention retained.                                                                      |
| 23          | `f9e882d`         | Logs CLI and named analysis catalog now built; offline read-only query and ingest/sweep paths.                                                                               |
| 25          | `7828552`         | k6 point loader and bucket-overlap comparison now built; test port adds no service.                                                                                          |
| 26          | `df31cdd`         | Removed platform/compiler.ts and throwing compatibility wrappers; pure compilation stays within existing components.                                                         |
| MT-01       | `c2cc3fa`         | Postgres 17 central tenant/key schema and persistent dev volume; new Level 2 store/process.                                                                                  |
| MT-01b      | `69cbd77`         | Journaled/advisory-locked migration CLI; used by MT-10.                                                                                                                      |
| MT-02       | `d71ea77`         | Config tenancy modes, database URL, tenant directories and router selection; no separate process.                                                                            |
| MT-03       | `6f448f8`         | Postgres TenantRegistry service; live scope-owned lazy acquisition in server root.                                                                                           |
| MT-04       | `4eeacbf`         | TenantContext and per-app LocalFolderRouter; validated tenant files and leased, scope-owned Storage cache.                                                                   |
| MT-05       | `6d7df35`         | Admin tenant/key HTTP operations backed by registry.                                                                                                                         |
| MT-06       | `027e177`         | Tenant administration CLI via admin HTTP; registry SQL stays in the server.                                                                                                  |
| MT-07       | `ebd89fa`         | Credential-derived tenant context, hashed-key cache and trusted tenant reader IPC.                                                                                           |
| MT-08       | `9ff9859`         | Headless Better Auth HTTP/CLI, Postgres users/sessions/memberships; no external identity provider.                                                                           |
| MT-09       | `c9ba958`         | Tenant-routing properties; no new runtime C4 surface.                                                                                                                        |
| MT-10       | `643b706`         | Reader live analysis wired to catalog/shared ingest instance; E2E uses distinct tenants for incompatible layouts (not per-app storage directories). Seven-scenario E2E gate. |

**Connected:** server layers, tenant auth/registry/routing when enabled, reader queries and named analysis,
admin/hourly ingest-then-sweep, standalone logs/tenant/auth/migration CLIs, k6 point loader. **Library only:**
`startRetentionSweeper` (not mounted), `upgradeEventLog` (explicit operator API, no CLI). **Future:**
control-plane routing, event-table pruning and DuckDB compaction. No future work is drawn as a running
service. Tests and counts are dated in the root [README.md](../../README.md).

Each diagram pair's numbered relationship keys are identical in both formats. Component and observability
terminal pictures use the keys to avoid crossing arrows; their boxes keep the same reading order as the
Mermaid definitions.

## Not drawn yet

- **Level 3 — reader components.** The reader composition is described in prose in the observability pair
  (`platform/reader_layers.ts`: Config, reader logging, IdGen, EventLogIngest, plus lazily opened per-app
  readers). A separate reader-component diagram is deferred; the live catalog is described in the
  observability pair.
- **Level 4 — Code.** No additional type-structure diagram is needed.

## Regenerating both formats

Both Mermaid documents and terminal box-drawing are generated from the sources in [`diagrams/`](diagrams), not
hand-edited:

```sh
python3 docs/architecture/diagrams/render.py           # regenerate both formats
python3 docs/architecture/diagrams/render.py --check   # non-zero exit if either format is stale
```

## Reflection astra-2

All four pairs were audited at `cd669d1` on 2026-10-11. The updates describe supervised reader restart and
correct tenant CLI transport, tenant backup limitations and missing tenant telemetry. See
[the full reflection](reflection-astra-2.md) for phase results and follow-ups.
