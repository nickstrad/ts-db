# Architecture diagrams

[C4 model](https://c4model.com/) diagrams for this repo. Every diagram exists in two formats: `*.github.md`
(Mermaid, rendered by GitHub) and `*.terminal.md` (box-drawing, built for `glow`). They are two renderings of
one diagram — same elements, same relationships, same markers.

Conventions, naming and the maintenance contract: [`AGENTS.md`](AGENTS.md).

## Index

| Level | Diagram                        | What it shows                                                                                                                                              | GitHub                                         | Terminal                                           |
| ----- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| 1     | System Context                 | The platform as one box: app developers, players, the operator, and the external object store, DuckDB analytics consumer and k6 load generator.            | [github](c4-context-document-db.github.md)     | [terminal](c4-context-document-db.terminal.md)     |
| 2     | Container — request path       | The server process, the DuckDB reader child process, the per-app SQLite files and the object store, and how a request and a backup move between them.      | [github](c4-container-platform.github.md)      | [terminal](c4-container-platform.terminal.md)      |
| 2     | Container — observability path | Server/reader JSONL, the reader's connected ingest-then-sweep into the derived DuckDB event log, the reader composition, and the planned item 23/25 edges. | [github](c4-container-observability.github.md) | [terminal](c4-container-observability.terminal.md) |
| 3     | Component — server process     | The mounted HTTP/lifecycle components and services, including per-app AppServices, storage, backups, reader client, logging and dependencies.              | [github](c4-component-server.github.md)        | [terminal](c4-component-server.terminal.md)        |

Level 2 is split in two so neither picture is cluttered; together they cover one container set.

## Reading them in a terminal

```sh
glow docs/architecture/c4-context-document-db.terminal.md
glow docs/architecture/c4-container-platform.terminal.md
glow docs/architecture/c4-container-observability.terminal.md
glow docs/architecture/c4-component-server.terminal.md
```

## Audited state

These diagrams describe the **current** tree; elements that are not built are drawn dashed and labelled
`(planned)` or `[planned]`. Source: branch `item/37-docs-reconciliation` at `e423ed1` (local `origin/main`,
2026-10-11), after items 22, 24 and 30-36 landed. Every claim below was checked against the landed diff, not
against the plan. Remote freshness was not re-verified from the editing environment.

| Item | Landed as                     | What the diagrams rely on                                                                                      |
| ---- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 22   | `89c4c40` (builder `47e0ac6`) | `PlatformLive`, per-app `AppServices`, HTTP router/auth/handlers, backup fiber, shutdown order.                |
| 24   | `1761d09` (builder `d961ce1`) | `platform/logging/retention.ts` sweeper; reworked by item 36.                                                  |
| 30   | `abf54ba` (builder `cfd24f4`) | json-layout number reads cast to REAL in the SQLite compiler (no new component).                               |
| 31   | `f879fc7` (builder `ef50a8a`) | U+0000 rejected before commit in `core/schema.ts` and `Storage` (ADR 0005).                                    |
| 32   | `bf884c6` (builder `632554c`) | `makeServer`, `ReaderProcess`, reader-exit shutdown, hourly ingest-then-sweep timer, `ListenError`.            |
| 33   | `5108825` (builder `cdb6164`) | `platform/reader_layers.ts` and `reader_context.ts`; the reader's `ingest` RPC reaches `EventLogIngestLive`.   |
| 34   | `33f16ff`                     | `X-Trace-Id` ingress rule, handler spans and `handler` events, trace captured into the reader frame.           |
| 35   | `1f00391` (builder `a08e39c`) | Event-log schema v2: `event_id`, `event_kind`/`handler_kind`, backup `emitter`/`run_id`/`attempts` (ADR 0006). |
| 36   | `827bdc4` (builder `6944503`) | Retention gated on committed ingest, ingest-then-sweep coordinator, derived-DB budget reporting (ADR 0007).    |

What is connected at runtime, what is only a library, and what is a target:

- **Connected:** server layers and listener; reader child with its own root; ingest RPC (hourly timer,
  `POST /admin/logs/ingest`); retention, only inside that RPC; caller trace from SDK to server to reader.
- **Library only:** `startRetentionSweeper` (exported, mounted nowhere); `upgradeEventLog` (operator step, no
  CLI).
- **Target, not built:** item 23 (`platform/analysis/catalog.ts`, `scripts/logs.ts`, `docs/observability.md`;
  `deno.json` declares `logs:*` tasks whose script is absent), item 25 (`perf/ingest_k6.ts`), event-table
  pruning (`logs:compact`), and the multitenancy items.
- **Tested composition:** `tests/unit/trace_e2e_test.ts`, `reader_ingest_test.ts`, `retention_ingest_test.ts`
  and `server_scope_test.ts` run the real SDK, server, reader child and event-log file together. The test
  counts and the date of the last full runs are recorded in the root [`README.md`](../../README.md).

Each diagram pair's numbered relationship keys are identical in both formats. Component and observability
terminal pictures use the keys to avoid crossing arrows; their boxes keep the same reading order as the
Mermaid definitions.

## Not drawn yet

- **Level 3 — reader components.** The reader composition is described in prose in the observability pair
  (`platform/reader_layers.ts`: Config, reader logging, IdGen, EventLogIngest, plus lazily opened per-app
  readers). A separate reader-component diagram is deferred; there is no live analysis catalog.
- **Level 4 — Code.** No additional type-structure diagram is needed.

## Regenerating the terminal format

The box-drawing is generated from the sources in [`diagrams/`](diagrams), not hand-edited:

```sh
python3 docs/architecture/diagrams/render.py           # rewrite every terminal embed
python3 docs/architecture/diagrams/render.py --check   # non-zero exit if an embed is stale
```
