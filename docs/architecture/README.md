# Architecture diagrams

[C4 model](https://c4model.com/) diagrams for this repo. Every diagram exists in two formats: `*.github.md`
(Mermaid, rendered by GitHub) and `*.terminal.md` (box-drawing, built for `glow`). They are two renderings of
one diagram — same elements, same relationships, same markers.

Conventions, naming and the maintenance contract: [`AGENTS.md`](AGENTS.md).

## Index

| Level | Diagram                        | What it shows                                                                                                                                                                                       | GitHub                                         | Terminal                                           |
| ----- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| 1     | System Context                 | The platform as one box: app developers, players, the operator, and the external object store, DuckDB analytics consumer and k6 load generator.                                                     | [github](c4-context-document-db.github.md)     | [terminal](c4-context-document-db.terminal.md)     |
| 2     | Container — request path       | The server process, the DuckDB reader child process, the per-app SQLite files and the object store, and how a request and a backup move between them.                                               | [github](c4-container-platform.github.md)      | [terminal](c4-container-platform.terminal.md)      |
| 2     | Container — observability path | Where events go: rotating JSONL log directories (built, item 11; the reader mounts its sink since item 16), the DuckDB event log and the `logs` CLI (planned), and k6 results (built, items 03/14). | [github](c4-container-observability.github.md) | [terminal](c4-container-observability.terminal.md) |
| 3     | Component — server process     | The Effect services and layers inside the server: HTTP API, AppRegistry (planned); Backups, Storage, ReaderClient, ObjectStore, Logger/EventSink, Config and the pure `core/` kernel (built).       | [github](c4-component-server.github.md)        | [terminal](c4-component-server.terminal.md)        |

Level 2 is split in two so neither picture is cluttered; together they cover one container set.

## Reading them in a terminal

```sh
glow docs/architecture/c4-context-document-db.terminal.md
glow docs/architecture/c4-container-platform.terminal.md
glow docs/architecture/c4-container-observability.terminal.md
glow docs/architecture/c4-component-server.terminal.md
```

## Target architecture, not current state

This repo is mid-way through the Effect-TS port and observability plan in
[`../plans/effect-port-and-observability.md`](../plans/effect-port-and-observability.md). These diagrams draw
the **target** architecture from that plan. Anything not on `main` yet is marked `(planned)` in its label
_and_ drawn with a dashed border, usually with the plan item number that delivers it. As of the audit on
2026-10-10, plan items 01–14 have landed: 01 (dependency pins and tasks), 02 (error taxonomy and service
tags), 03 (k6 install and smoke scenario), 04 (`core/schema.ts`), 05 (`core/ipc/framing.ts`), 06
(`core/logging/rotation.ts`), 07 (`core/events.ts`), 08 (`platform/config.ts`), 09 (`core/compile/*`), 10
(Effect-based `sdk/`), 11 (`platform/logging/` Logger service and rotating JSONL sink), 12–13
(`tests/property/` waves 1 and 2) and 14 (`perf/` k6 load scenarios). Items 15–18 (Storage, Reader,
ReaderClient, ObjectStore) were in progress at the audit; items 15 (Storage), 16 (Reader), 17 (ReaderClient),
18 (ObjectStore), 19 (Backups) and 20 (in-memory test layers) have all landed since. So:

- Level 1 and the Level 2 request path are **built** — the container topology does not change. The SDK is
  already Effect-based; the reader is a scoped Effect program (item 16), the parent-side IPC is the scoped
  `ReaderClient` service (item 17), the writer is the scoped `Storage` service (item 15), and the server
  process is still the pre-port code (item 22).
- The Level 2 observability path is **half built**: the JSONL log directories and the layer that writes them
  are real (item 11), and the reader mounts it at runtime since item 16 — a running reader now appends to
  `<LOG_DIR>/reader/`. The server does not mount it until item 22. The DuckDB event log, the `logs` CLI and
  the retention sweeper are planned (items 21, 23, 24).
- Level 3 is **built from the bottom up**: the `core/` kernel (items 02, 04–09), `Config` (item 08), `Storage`
  (item 15), `Logger + EventSink` (item 11), `ObjectStore` (item 18), `ReaderClient` (item 17) and `Backups`
  (item 19) exist as Effect layers with tests. The `HTTP API` and `AppRegistry` services and the
  `PlatformLive` composition are planned (item 22), and `platform/server.ts` does not yet mount the landed
  layers.

## Not drawn yet

- **Level 3 — the reader process** (`Reader`, `EventLogIngest`, `Analysis` composing into `ReaderLive`). The
  natural next diagram.
- **Level 4 — Code.** Nothing yet needs it; see `AGENTS.md` for the bar it has to clear.

## Regenerating the terminal format

The box-drawing is generated from the sources in [`diagrams/`](diagrams), not hand-edited:

```sh
python3 docs/architecture/diagrams/render.py           # rewrite every terminal embed
python3 docs/architecture/diagrams/render.py --check   # non-zero exit if an embed is stale
```
