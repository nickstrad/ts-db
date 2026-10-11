# Architecture diagrams

[C4 model](https://c4model.com/) diagrams for this repo. Every diagram exists in two formats: `*.github.md`
(Mermaid, rendered by GitHub) and `*.terminal.md` (box-drawing, built for `glow`). They are two renderings of
one diagram — same elements, same relationships, same markers.

Conventions, naming and the maintenance contract: [`AGENTS.md`](AGENTS.md).

## Index

| Level | Diagram                        | What it shows                                                                                                                                         | GitHub                                         | Terminal                                           |
| ----- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| 1     | System Context                 | The platform as one box: app developers, players, the operator, and the external object store, DuckDB analytics consumer and k6 load generator.       | [github](c4-context-document-db.github.md)     | [terminal](c4-context-document-db.terminal.md)     |
| 2     | Container — request path       | The server process, the DuckDB reader child process, the per-app SQLite files and the object store, and how a request and a backup move between them. | [github](c4-container-platform.github.md)      | [terminal](c4-container-platform.terminal.md)      |
| 2     | Container — observability path | Server/reader JSONL, k6 artifacts, and the implemented DuckDB event-log format with its missing runtime wiring.                                       | [github](c4-container-observability.github.md) | [terminal](c4-container-observability.terminal.md) |
| 3     | Component — server process     | The mounted HTTP/lifecycle components and services, including per-app AppServices, storage, backups, logging and dependencies.                        | [github](c4-component-server.github.md)        | [terminal](c4-component-server.terminal.md)        |

Level 2 is split in two so neither picture is cluttered; together they cover one container set.

## Reading them in a terminal

```sh
glow docs/architecture/c4-context-document-db.terminal.md
glow docs/architecture/c4-container-platform.terminal.md
glow docs/architecture/c4-container-observability.terminal.md
glow docs/architecture/c4-component-server.terminal.md
```

## Audited state

This sync pass inspected the landed source at local `origin/main`, `1761d09ecd22d6cb481819dec3d5b3eed6763c0c`
(2026-10-11). Remote freshness could not be verified in the editing environment: Git metadata was read-only
and the GitHub hostname did not resolve. No changes were copied from `reflection/astra` or in-flight item
branches.

- Item 22 mounts the server layers, per-app `AppServices`, HTTP router, logging and backup fiber.
- Item 21 implements the persistent event-log service, but `platform/reader.ts` still returns stub failures
  for ingest and analysis. Its actual layer root contains only config and logging; app query readers are
  opened lazily with a separate in-memory DuckDB instance per app.
- Item 24 implements retention and a daily fiber helper; neither the server nor reader starts it.
- Item 23's `scripts/logs.ts` and `platform/analysis/catalog.ts` are absent. The claim that every item from 01
  through 24 is landed is therefore not supported by this tree or its log.
- Items 30 and 35 are omitted. Planned event-log runtime wiring and item-25 k6 ingest use explicitly labelled
  dashed arrows. Solid implemented artifacts do not imply their integration is active.

The diagrams distinguish runtime wiring from available implementations. Their numbered relationship keys are
identical in both formats. Component and observability terminal pictures use the keys to avoid crossing
arrows; their boxes keep the same reading order as the Mermaid definitions.

## Not drawn yet

- **Level 3 — reader components.** The current reader root is `ReaderProcessLive` in `platform/reader.ts`,
  with a lazy pool from `platform/duckdb.ts`; there is no live Analysis catalog.
- **Level 4 — Code.** No additional type-structure diagram is needed for this sync pass.

## Regenerating the terminal format

The box-drawing is generated from the sources in [`diagrams/`](diagrams), not hand-edited:

```sh
python3 docs/architecture/diagrams/render.py           # rewrite every terminal embed
python3 docs/architecture/diagrams/render.py --check   # non-zero exit if an embed is stale
```
