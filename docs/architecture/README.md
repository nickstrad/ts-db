# Architecture diagrams

[C4 model](https://c4model.com/) diagrams for this repo. Every diagram exists in two formats:
`*.github.md` (Mermaid, rendered by GitHub) and `*.terminal.md` (box-drawing, built for `glow`).
They are two renderings of one diagram — same elements, same relationships, same markers.

Conventions, naming and the maintenance contract: [`AGENTS.md`](AGENTS.md).

## Index

| Level | Diagram | What it shows | GitHub | Terminal |
| --- | --- | --- | --- | --- |
| 1 | System Context | The platform as one box: app developers, players, the operator, and the external object store, DuckDB analytics consumer and k6 load generator. | [github](c4-context-document-db.github.md) | [terminal](c4-context-document-db.terminal.md) |
| 2 | Container — request path | The server process, the DuckDB reader child process, the per-app SQLite files and the object store, and how a request and a backup move between them. | [github](c4-container-platform.github.md) | [terminal](c4-container-platform.terminal.md) |
| 2 | Container — observability path | Where events go: rotating JSONL log directories, the DuckDB event log, k6 results and the `logs` CLI. Almost all planned. | [github](c4-container-observability.github.md) | [terminal](c4-container-observability.terminal.md) |
| 3 | Component — server process | The Effect services and layers inside the server: HTTP API, Storage, ReaderClient, Backups, ObjectStore, AppRegistry, Logger/EventSink, Config and the pure `core/` kernel. All planned. | [github](c4-component-server.github.md) | [terminal](c4-component-server.terminal.md) |

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
[`../plans/effect-port-and-observability.md`](../plans/effect-port-and-observability.md). These
diagrams draw the **target** architecture from that plan. Anything not on `main` yet is marked
`(planned)` in its label *and* drawn with a dashed border, usually with the plan item number that
delivers it. As of the first batch of diagrams, plan items 01 (dependency pins and tasks), 02
(error taxonomy and service tags) and 03 (k6 install and smoke scenario) had landed, so:

- Level 1 and the Level 2 request path are mostly **built** — the container topology does not change.
- The Level 2 observability path is mostly **planned**; the k6 results directory is real.
- Level 3 is almost entirely **planned**: item 02 landed the error taxonomy and the service tags,
  so the bottom tier of the diagram is the contract the implementations will be written against.

## Not drawn yet

- **Level 3 — the reader process** (`Reader`, `EventLogIngest`, `Analysis` composing into
  `ReaderLive`). The natural next diagram.
- **Level 4 — Code.** Nothing yet needs it; see `AGENTS.md` for the bar it has to clear.

## Regenerating the terminal format

The box-drawing is generated from the sources in [`diagrams/`](diagrams), not hand-edited:

```sh
python3 docs/architecture/diagrams/render.py           # rewrite every terminal embed
python3 docs/architecture/diagrams/render.py --check   # non-zero exit if an embed is stale
```
