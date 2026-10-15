# Conversion inventory: `tsdb-lanes-proposal`

Title: "Proposed: statement lanes and tenant placement (scale-out)". This dataset proposes **only** the
unbuilt scale-out design: statement lanes, the placement table, the forwarder, the lane supervisor, the peer
node and WAL frames. The FFI execution layer (FFI-01 to FFI-08: binding, statement classifier, deadline and
HTTP 504) has landed on `main` and is part of `tsdb-current`; here it appears as `existing`, never as the
proposal.

Bundle:
[`public/architectures/tsdb-lanes-proposal.json`](../../public/architectures/tsdb-lanes-proposal.json).
Source: the proposed context and container pairs in `docs/plans/ffi/` on branch `docs/ffi-c4` at
[`81d9936`](https://github.com/nickstrad/ts-db/tree/81d9936df084763c1577f37bd844b4ff00b95fdc/docs/plans/ffi)
(not merged to `main`; read with `git show`), corrected against `main` at `2d30330`, where the FFI execution
layer (FFI-01 to FFI-08) has landed. Converted by PG-01 (`opus-pg-01`) on 2026-10-15.

Scope: the **context** and **container (data node with lanes)** views only. Deferred to PG-02: the lane
component view (`c4-component-ffi-lane`), the four dynamic flows of the FFI README (point read, deadline and
interrupt, forwarded mutation, kill and restart), an illustrative deployment, a landscape view and a code view
of `platform/document_reader.ts`.

Statuses: lanes, the placement table, the forwarder, the lane supervisor, the peer node and WAL frames are
`planned` (alone, or as `plannedNotes` of a `mixed` element or relationship). Everything that exists on `main`
is `existing`. The bundle test (`tests/bundles.test.ts`) fails if any element or relationship id is missing
from this file.

## Sources

| Source id              | File                                                                                                                                                                                      | Revision  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `src-ctx-github`       | [docs/plans/ffi/c4-context-ffi.github.md](https://github.com/nickstrad/ts-db/blob/81d9936df084763c1577f37bd844b4ff00b95fdc/docs/plans/ffi/c4-context-ffi.github.md)                       | `81d9936` |
| `src-ctx-terminal`     | [docs/plans/ffi/c4-context-ffi.terminal.md](https://github.com/nickstrad/ts-db/blob/81d9936df084763c1577f37bd844b4ff00b95fdc/docs/plans/ffi/c4-context-ffi.terminal.md)                   | `81d9936` |
| `src-ctx-py`           | [docs/plans/ffi/diagrams/c4-context-ffi.py](https://github.com/nickstrad/ts-db/blob/81d9936df084763c1577f37bd844b4ff00b95fdc/docs/plans/ffi/diagrams/c4-context-ffi.py)                   | `81d9936` |
| `src-ctr-github`       | [docs/plans/ffi/c4-container-ffi.github.md](https://github.com/nickstrad/ts-db/blob/81d9936df084763c1577f37bd844b4ff00b95fdc/docs/plans/ffi/c4-container-ffi.github.md)                   | `81d9936` |
| `src-ctr-terminal`     | [docs/plans/ffi/c4-container-ffi.terminal.md](https://github.com/nickstrad/ts-db/blob/81d9936df084763c1577f37bd844b4ff00b95fdc/docs/plans/ffi/c4-container-ffi.terminal.md)               | `81d9936` |
| `src-ctr-py`           | [docs/plans/ffi/diagrams/c4-container-ffi.py](https://github.com/nickstrad/ts-db/blob/81d9936df084763c1577f37bd844b4ff00b95fdc/docs/plans/ffi/diagrams/c4-container-ffi.py)               | `81d9936` |
| `src-ffi-readme`       | [docs/plans/ffi/README.md](https://github.com/nickstrad/ts-db/blob/81d9936df084763c1577f37bd844b4ff00b95fdc/docs/plans/ffi/README.md)                                                     | `81d9936` |
| `src-ffi-ste`          | [docs/plans/ffi/architecture-ste100.md](https://github.com/nickstrad/ts-db/blob/81d9936df084763c1577f37bd844b4ff00b95fdc/docs/plans/ffi/architecture-ste100.md)                           | `81d9936` |
| `src-lang-switch`      | [docs/architecture/lang-switch-fable.md](https://github.com/nickstrad/ts-db/blob/d97bcf8f145e94279b882665c70412eabdaba775/docs/architecture/lang-switch-fable.md)                         | `d97bcf8` |
| `src-ffi-plan`         | [docs/plans/ffi-implementation.md](https://github.com/nickstrad/ts-db/blob/2d30330ed2c0aa967fb737827e43a7cbb8714e59/docs/plans/ffi-implementation.md)                                     | `2d30330` |
| `src-adr-0008`         | [docs/adr/0008-statement-execution-via-ffi.md](https://github.com/nickstrad/ts-db/blob/2d30330ed2c0aa967fb737827e43a7cbb8714e59/docs/adr/0008-statement-execution-via-ffi.md)             | `2d30330` |
| `src-sqlite-ffi`       | [platform/sqlite_ffi/README.md](https://github.com/nickstrad/ts-db/blob/2d30330ed2c0aa967fb737827e43a7cbb8714e59/platform/sqlite_ffi/README.md)                                           | `2d30330` |
| `src-classify`         | [platform/sqlite_ffi/classify.ts](https://github.com/nickstrad/ts-db/blob/2d30330ed2c0aa967fb737827e43a7cbb8714e59/platform/sqlite_ffi/classify.ts)                                       | `2d30330` |
| `src-current-platform` | [docs/architecture/c4-container-platform.github.md](https://github.com/nickstrad/ts-db/blob/2d30330ed2c0aa967fb737827e43a7cbb8714e59/docs/architecture/c4-container-platform.github.md)   | `2d30330` |
| `src-current-context`  | [docs/architecture/c4-context-document-db.github.md](https://github.com/nickstrad/ts-db/blob/2d30330ed2c0aa967fb737827e43a7cbb8714e59/docs/architecture/c4-context-document-db.github.md) | `2d30330` |

## System Context — proposed lanes and tenant placement → diagram `lanes-context`

Source: `docs/plans/ffi/c4-context-ffi.github.md` and `.terminal.md`.

### Elements

| Source node | Source box                                                                                                                       | Element id  | Status   | Documents            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- | -------------------- |
| `db`        | Document DB platform [Software system]: Deno API nodes; statement lanes with FFI to libsqlite3 (planned); DuckDB event-log child | `platform`  | mixed    | `doc-platform`       |
| `registry`  | Central registry and placement [Software system, part of the platform]; placement table (planned)                                | `registry`  | mixed    | `doc-registry`       |
| `developer` | App developer [Person]                                                                                                           | `developer` | existing | none (box text only) |
| `caller`    | Application caller [Person]                                                                                                      | `caller`    | existing | none (box text only) |
| `operator`  | Platform operator [Person]; placement moves (planned)                                                                            | `operator`  | mixed    | none (box text only) |
| `objects`   | Object storage [External system]; WAL frames (planned, phase two)                                                                | `objects`   | mixed    | `doc-objects`        |
| `analytics` | Analytics consumer [External system]                                                                                             | `analytics` | existing | none (box text only) |

### Relationships

| Source edge | From → to                                             | Relationship id | Status   | Planned notes                                                                      |
| ----------- | ----------------------------------------------------- | --------------- | -------- | ---------------------------------------------------------------------------------- |
| (1)         | App developer → Document DB platform                  | `ctx-1`         | existing | —                                                                                  |
| (2)         | Application caller → Document DB platform             | `ctx-2`         | mixed    | Forwarding: a node that does not own the tenant forwards the request to the owner. |
| (3)         | Platform operator → Document DB platform              | `ctx-3`         | mixed    | Placement-move operations.                                                         |
| (4)         | Document DB platform → Central registry and placement | `ctx-4`         | mixed    | Placement lookup and lease heartbeat.                                              |
| (5)         | Document DB platform → Object storage                 | `ctx-5`         | mixed    | WAL frames (phase two).                                                            |
| (6)         | Document DB platform → Analytics consumer             | `ctx-6`         | existing | —                                                                                  |

## Container — data node with statement lanes → diagram `lanes-containers`

Source: `docs/plans/ffi/c4-container-ffi.github.md` and `.terminal.md`.

### Elements

| Source node | Source box                                                                            | Element id   | Status   | Documents            |
| ----------- | ------------------------------------------------------------------------------------- | ------------ | -------- | -------------------- |
| `api`       | API process [Deno process]; placement router, forwarder and lane supervisor (planned) | `api`        | mixed    | `doc-api`            |
| `lanes`     | Statement lanes (planned) [Deno child processes]; platform/lane.ts (planned)          | `lanes`      | planned  | `doc-lanes`          |
| `files`     | Tenant documents [SQLite 3 WAL files]; writer handle 3 fds, read-only handle 2        | `files`      | existing | `doc-files`          |
| `reader`    | Reader process [Deno child process]                                                   | `reader`     | existing | none (box text only) |
| `client`    | Typed client SDK [Library in caller process]                                          | `client-sdk` | existing | none (box text only) |
| `pg`        | Central registry and placement [Postgres 17 process/store]; placement table (planned) | `registry`   | mixed    | `doc-registry`       |
| `peer`      | Peer data node (planned) [Deno process on another host]                               | `peer`       | planned  | `doc-peer`           |
| `objects`   | Object storage [External system / filesystem]; WAL frames (planned)                   | `objects`    | mixed    | `doc-objects`        |

### Relationships

| Source edge | From → to                                    | Relationship id                 | Status   | Planned notes                                                                                                                                     |
| ----------- | -------------------------------------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| (1)         | Typed client SDK → API process               | `ctr-1`                         | existing | —                                                                                                                                                 |
| (2)         | API process → Central registry and placement | `ctr-2`                         | mixed    | Placement lookup and lease heartbeat.                                                                                                             |
| (3)         | API process → Peer data node                 | `ctr-3`                         | planned  | —                                                                                                                                                 |
| (4)         | API process → Statement lanes                | `ctr-4`                         | planned  | —                                                                                                                                                 |
| (5)         | Statement lanes → System libsqlite3          | folded into `ctr-6` and `lanes` | planned  | Source label: "Deno.dlopen symbols: blocking step; nonblocking step; sqlite3_interrupt (planned)" — now the `technology` of `ctr-6` (decision P2) |
| (6)         | Statement lanes → Tenant documents           | `ctr-6`                         | planned  | —                                                                                                                                                 |
| (7)         | API process → Tenant documents               | `ctr-7`                         | mixed    | Retired when the lanes land: the lanes then own every open of a tenant file.                                                                      |
| (8)         | API process → Reader process                 | `ctr-8`                         | existing | —                                                                                                                                                 |
| (9)         | API process → Object storage                 | `ctr-9`                         | mixed    | WAL frames (phase two).; Snapshots taken from a read-only connection.                                                                             |

### Source labels that changed

| Id         | Source text (81d9936)                                                                                                                                   | Bundle text                                                                                                                                                                      | Why                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ctr-6`    | System libsqlite3 (planned) → Tenant documents: "WAL reads and writes; BEGIN IMMEDIATE per mutation; VACUUM INTO from a read-only connection (planned)" | Statement lanes → Tenant documents, same label without "(planned)"; technology "Deno.dlopen symbols: blocking step; nonblocking step; sqlite3_interrupt" (source edge 5's label) | P2: libsqlite3 is a library inside the lane             |
| `ctr-7`    | "node:sqlite reads and serialized mutations (today; moves into the lanes)"                                                                              | "Reads and serialized mutations through the FFI binding (today; moves into the lanes)"; technology "Deno FFI to system libsqlite3"                                               | P1: FFI-04 (`51a5283`) replaced `node:sqlite` on `main` |
| `platform` | "Deno API nodes; statement lanes with FFI to libsqlite3 (planned); DuckDB event-log child"                                                              | "Deno API node that executes SQLite through Deno FFI to the system libsqlite3 (landed, FFI-01 to FFI-08); DuckDB event-log child" + planned notes for lanes and several nodes    | P1                                                      |
| `api`      | "HTTP auth and tenant context; placement router, forwarder and lane supervisor (planned)"                                                               | landed FFI execution added to the description; router, forwarder, supervisor and the end of file access as planned notes                                                         | P1                                                      |
| `files`    | "One file per tenant; writer handle 3 fds, read-only handle 2"                                                                                          | "One file per tenant"; descriptor counts moved to `doc-measurements`                                                                                                             | P5                                                      |
| all        | literal "(planned)" in names, paths and labels                                                                                                          | removed; `status`, dashed stroke and the "planned" card text carry it                                                                                                            | P6                                                      |

## Mermaid and terminal discrepancies (review notes)

Compared on 2026-10-15: in both pairs the prose above the picture differs only in the render marker, and the
relationship table and runtime notes are byte-identical. The pictures carry the same boxes in the same order.

1. **Terminal pictures draw no arrows.** Relationships exist only in the numbered key (identical in both
   formats).
2. **Planned edges are not dashed in the context Mermaid.** Context edges 2, 3, 4 and 5 carry planned parts
   (forwarding, placement moves, placement lookup and lease heartbeat, WAL frames) but are drawn solid (`-->`)
   with no "(planned)" word; only the boxes say "(planned)". The bundle marks them `mixed` with planned notes,
   which renders them dashed.
3. **Mixed boxes are drawn solid.** `db`, `registry`, `api`, `operator` and `objects` contain "(planned)"
   parts but use solid borders in both formats (only wholly planned boxes are dashed). The bundle marks them
   `mixed`.
4. **The registry changes type between views.** `[Software system, part of the platform]` in the context and
   `[Postgres 17 process/store]`, drawn outside the data-node boundary with the `external` class, in the
   container view. One element `registry` (a software system, decision P4) serves both.
5. **Edge 9 hides its planned part.** "Snapshot verification/hash and publication; WAL frames" is solid in
   Mermaid although WAL frames are planned (the box says "WAL frames (planned)"). The bundle marks `ctr-9`
   `mixed`.
6. **Timing numbers sit only in prose, not on the drawn labels**, in both formats; the bundle keeps them out
   of every label as well (P5).

## Conversion decisions

- **P1. Landed FFI parts are `existing`.** The source (2026-10-12, baseline `e808983`) marks the FFI binding,
  the statement classifier and the deadline/interrupt path planned. They landed on `main` in FFI-01 to FFI-08
  (2026-10-14; plan
  [`docs/plans/ffi-implementation.md`](https://github.com/nickstrad/ts-db/blob/2d30330ed2c0aa967fb737827e43a7cbb8714e59/docs/plans/ffi-implementation.md);
  binding at `platform/sqlite_ffi/`, not the source's `platform/ffi/sqlite.ts`). They run in the API process,
  not in lanes. So `api`, `platform` and `ctr-7` describe them as existing, and only their placement inside
  lanes stays planned. FFI plan §6 confirms lanes and placement were not built.
- **P2. `libsqlite3` is not a container.** The source's "System libsqlite3 (planned) [Shared library via Deno
  FFI, one per lane]" is an implementation dependency loaded into a process. It is folded into the
  `technology` of `api` (existing) and `lanes` (planned). Source edge 5 (lanes → libsqlite3) becomes the
  technology of `ctr-6`, and edge 6 (libsqlite3 → files) becomes `ctr-6` from `lanes`, numbered 6. No
  relationship has number 5; the container key explains the gap. The lane's internal FFI binding component is
  PG-02's lane component view; no code-level FFI classes are invented.
- **P3. Planned instantiation is recorded separately from code reuse.** `lanes` is `planned`; its document
  says the code it would run exists today in the API process. Existing logger or binding code does not make a
  lane exist.
- **P4. The registry is a software system, as the source context draws it.** It sits in the organisation
  boundary group `g-organisation` with the platform (the source's "Document DB platform" subgraph). The
  current dataset models the same Postgres as a container of the platform; the two datasets keep their own
  identities.
- **P5. Timing numbers live in one document with provenance.** `doc-measurements` lists every number the
  source quotes (lang-switch study §3, vm-1, 2026-10-12), with the study's limits, and states that a bounded
  plan is not a wall-clock bound. No label, name or description carries a measurement. The descriptor counts
  on the files box moved there as well.
- **P6. "(planned)" words become status.** The source writes "(planned)" into names, paths and labels (belt
  and braces for plain Mermaid). The bundle uses `status`, which the SDK renders as a dashed stroke plus the
  words "planned" or "Existing + planned changes" on every card and in the text alternative.
- **P7. The peer data node is a planned container.** The source draws it as one box "same containers as this
  node" outside the data-node boundary. It is a planned container of the platform outside group `g-data-node`;
  a deployment view with real instances is PG-02's.
- **P8. Omissions follow the source.** k6, the tenant/auth CLI and the migration runner are omitted, as the
  source context says ("unchanged and omitted here for focus"). The observability path is unchanged except for
  one JSONL directory per lane (source README, "Not drawn").
- **P9. Statuses of mixed relationships.** `ctx-2` (forwarding), `ctx-3` (placement moves), `ctx-4` and
  `ctr-2` (placement lookup and lease heartbeat), `ctx-5` and `ctr-9` (WAL frames; `ctr-9` also snapshots from
  a read-only connection), `ctr-7` (retired when lanes land) are existing relationships with planned notes.
- **P10. Documents.** Both diagrams and every element with source prose (`platform`, `registry`, `objects`,
  `api`, `lanes`, `files`, `peer`) have plain and STE (ASD-STE100 Issue 9, `draft`) texts. The STE texts draw
  on the source's own STE restatement (`architecture-ste100.md`) and are not certified.
- **P11. Renamed from its first id, which carried an `ffi` prefix (Nick, 2026-10-14).** The old name read as
  if the FFI execution layer were still proposed, but FFI-01 to FFI-08 landed and `tsdb-current` already draws
  them. The dataset id is now `tsdb-lanes-proposal` and its two diagram ids are `lanes-context` and
  `lanes-containers` (were `ffi-context` and `ffi-containers`; old deep links to the proposed dataset are not
  redirected). Content, statuses, relationships and the side-by-side mechanics are unchanged. Kept on purpose:
  the bundle `revision` string (`docs-ffi-c4-81d9936-on-main-2d30330-pg01`), the source ids (`src-ffi-readme`,
  `src-ffi-plan`, ...) and the source paths, because they name real files and the branch `docs/ffi-c4` the
  diagrams were converted from; source titles now say "Source diagram ... (branch docs/ffi-c4)" instead of
  "FFI ...".
