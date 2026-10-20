# DP-01 inventory: `tsdb-planes-proposal`

Date: 2026-10-20. Builder: `sol-dp-01`. Proposal only; no runtime code is changed.

A tenant owns zero or more databases (0..N). The database is the unit of placement, isolation, backup and
lifecycle. One-file-per-tenant is superseded in this proposal; the lanes dataset stays unchanged.

## Sources

| Source ID             | Commit-pinned path                                                                                                                                                                          | Use                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src-brief`           | [agent-work/items/dp-01-planes/brief.md](https://github.com/nickstrad/ts-db/blob/6c3989e28aed5c5fa60d4f6c33730ce6885d5c9a/agent-work/items/dp-01-planes/brief.md)                           | DP-01 authorized design brief                                     |
| `src-addendum`        | [agent-work/items/dp-01-planes/addendum-1.md](https://github.com/nickstrad/ts-db/blob/item/dp-01-planes/agent-work/items/dp-01-planes/addendum-1.md)                                        | DP-01 addendum 1: VM agents and control-plane routing / placement |
| `src-lanes`           | [pages/public/architectures/tsdb-lanes-proposal.json](https://github.com/nickstrad/ts-db/blob/351a51bfe64c5f1172538d5a446c46c58a4c3b00/pages/public/architectures/tsdb-lanes-proposal.json) | Preserved scale-out dataset                                       |
| `src-lanes-inventory` | [pages/content/tsdb-lanes-proposal/inventory.md](https://github.com/nickstrad/ts-db/blob/351a51bfe64c5f1172538d5a446c46c58a4c3b00/pages/content/tsdb-lanes-proposal/inventory.md)           | Scale-out decisions P1–P17                                        |
| `src-router`          | [platform/tenants/routing.ts](https://github.com/nickstrad/ts-db/blob/351a51bfe64c5f1172538d5a446c46c58a4c3b00/platform/tenants/routing.ts)                                                 | Landed TenantStorageRouter seam; future ControlPlaneRouter        |
| `src-classifier`      | [platform/sqlite_ffi/classify.ts](https://github.com/nickstrad/ts-db/blob/351a51bfe64c5f1172538d5a446c46c58a4c3b00/platform/sqlite_ffi/classify.ts)                                         | Landed operation-IR classifier                                    |
| `src-ffi`             | [platform/sqlite_ffi/effect.ts](https://github.com/nickstrad/ts-db/blob/351a51bfe64c5f1172538d5a446c46c58a4c3b00/platform/sqlite_ffi/effect.ts)                                             | Landed scoped FFI and cancellation wrappers                       |
| `src-storage`         | [platform/sqlite.ts](https://github.com/nickstrad/ts-db/blob/351a51bfe64c5f1172538d5a446c46c58a4c3b00/platform/sqlite.ts)                                                                   | Landed Storage, connection gate and deadlines                     |
| `src-decisions`       | [docs/knowledge/decisions.md](https://github.com/nickstrad/ts-db/blob/351a51bfe64c5f1172538d5a446c46c58a4c3b00/docs/knowledge/decisions.md)                                                 | Router seam and Postgres handwritten SQL decisions                |

## Decisions and discrepancies

- **A1 — addendum precedence (2026-10-20).** Addendum 1 overrides the brief: routing authority and placement
  registry are in the control plane. The gateway consults that authority, not Postgres placement directly.
  Stale routes are invalidated after moves.
- **A2 — VM last mile.** Every VM runs **VM agent (process)**, a software daemon, not AI. Only this agent
  boundary (including private managed execution workers) accesses local tenant files. All external query and
  lifecycle work arrives as agent instructions. Agents report health, size and usage; source and target agents
  copy/fence/hand over under controller coordination.
- **A3 — placement remains OPEN.** n SQLite files span m VMs. Choosing the VM is a control-plane decision; its
  selection policy is an explicit unsolved open question. Reservation is non-routable intent, not confirmed
  placement. Publish registry placement after provision confirmation, flip a move after target-agent
  readiness, and clean a drop registry after agent deletion confirmation.
- **A4 — source reference.** The addendum is included in this change; its URL uses the item branch, while its
  revision records the exact source-byte SHA-256 verified by the source test. This avoids a self-referential
  commit hash. Other sources retain their original commit pins.
- **DP1 — identity.** Tenant → 0..N databases; immutable database ID is the placement, file, isolation, backup
  and lifecycle key. Names are unique within a tenant and never file paths. This intentionally supersedes the
  lanes proposal’s one-file-per-tenant model only here.
- **DP2 — scope/status.** New control/data planes, database-aware routing, files and all deployments are
  planned. Landed classifier and FFI code are existing; the routing seam is mixed because database-aware
  remote routing is new, and deadline policy is mixed because watchdog escalation is new. Existing code inside
  a planned process does not make the process landed (P1/P3/P13).
- **DP3 — context abstraction.** One software system at Level 1 with explicitly separate management and query
  paths. Level 2 expands it into the control plane, data plane and node-local hosting processes. Postgres is
  an internal container here (as in the current dataset), not the lanes dataset’s separate registry system
  (P4). Supporting containers/components are tagged external for SDK component grammar; the key explains that
  grey does not imply external ownership (D3/P12).
- **DP4 — router truth.** `platform/tenants/routing.ts` supplies the landed TenantStorageRouter capability
  seam; ControlPlaneRouter is a future implementation, not landed code. Its current `resolve(tenantId)` and
  tenant-only context cannot already select multiple databases. Database ID/context/client-selection extension
  is explicit planned work. Location resolution remains behind the seam; the brief’s unchanged Storage/client
  implementation-swap invariant does not magically add a database-selection API.
- **DP5 — metadata.** Postgres, hand-written SQL, no ORM. Database state and placement/epoch publish
  atomically using conditional transactions; file/RPC work uses durable operations and reconciliation, not an
  invented cross-store transaction. Tenant drop is restricted until its databases have completed deletion.
- **DP6 — dynamic access.** Same session/endpoint, database name or ID per selection. Authenticate and
  authorize the pair; resolve ACTIVE placement at open. Owner validates state/epoch for every admission, so a
  cached open is not perpetual access. Refresh WrongOwner at reopen; inactive/unknown state fails closed.
  Forward only server-trusted identities over authenticated RPC.
- **DP7 — relocation.** Chosen offline move: record MOVING, block opens, fence old admissions including
  sessions, drain/cancel all in-flight work, close handles, verify checkpointed copy, then flip owner+epoch
  and ACTIVE in one transaction. Target gates activation on committed placement; old owner remains fenced
  across restart. Source must acknowledge fencing: unreachable source means unavailable, not guessed failover.
  Confirm process exit after a kill before acknowledging drain. Pre-flip rollback needs verified intact source
  and confirmed target cleanup, and uses a fresh epoch. After-flip failures reconcile target
  activation/cleanup; no rollback to stale owner.
- **DP8 — deletion/restore.** Remove files and sidecars/all known copies before live registry cleanup; retain
  non-routable identity tombstone and operation history. Drop erases backups and archived WAL as well as local
  data; pending cleanup is never reported as success. Failed cleanup remains DROPPING and reserves the name.
  Backup/restore and suspend/resume use database gates/generations (see `doc-lifecycle-policies`).
- **DP9 — lane reuse.** Reuse placement table, forwarder, supervisor, statement lanes, per-database request-ID
  dedup, FFI classifier/deadline and optional WAL-frame vocabulary. Carry operation IR alongside SQL/binds so
  the classifier never parses SQL (lanes discrepancy 11). No tenant-wide sticky lane set, file, queue or lock.
  A shared child-process lane has a multi-database failure blast radius; it is not a database isolation
  boundary.
- **DP10 — omissions.** No invented code-level symbols, latency/capacity measurements, automatic failover,
  online migration or WAL-shipping implementation. Optional future WAL frames are database/generation keyed;
  offline verified snapshots suffice for this design. DuckDB event-log analysis and unchanged
  app/observability paths are omitted for focus (P8). Existing two bundles and their content remain
  byte-identical.
- **DP11 — documents and flows.** Every diagram and every element has plain and STE Issue 9 draft text (not
  certified). Each dynamic diagram has one sequence Step tree using model relationships. Failure alternatives
  are separate named diagrams. Reverse interactions are responses; edge numbers are model references, not
  timings. New edge numbering is local to this authored design; there is no prior Mermaid numbering to
  preserve (D1–D5/P1–P5 conventions retained where applicable).
- **DP12 — deployment.** Illustrative only: A=3, B=1, C=2 databases; Alpha spans A/B, Beta spans A/C, A mixes
  Alpha/Beta. Zero-database Delta has no file. Database files are instances of a logical datastore container,
  not extra containers. Every deployment edge names its matching logical model relationship.
- **DP13 — registration.** Data-driven `pages/public/catalog.json` requires an added catalog entry, not viewer
  code. The brief explicitly authorizes the minimal registration change even though that file is omitted from
  its initial Owns list. Existing default remains current.

## Elements

| ID                    | Kind / status            | Source IDs                                                         | Document IDs                              | Grounding / design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------ | ------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform`            | softwareSystem / planned | `src-brief`, `src-addendum`                                        | `doc-platform`                            | Management uses the control plane. Queries use the data plane. Both address databases by tenant and database identity; clients never select a hosting node.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `operator`            | person / planned         | `src-brief`, `src-addendum`                                        | `doc-operator`                            | Creates tenants and databases, inspects state and requests database lifecycle operations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `caller`              | person / planned         | `src-brief`, `src-addendum`                                        | `doc-caller`                              | One session can address any authorized database of its tenant by name or ID through the same query endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `backups`             | softwareSystem / planned | `src-brief`, `src-lanes`, `src-addendum`                           | `doc-backups`                             | Proposed verified snapshots and optional later WAL frames, keyed by immutable database ID and generation. Retention and erasure are explicit per-database policies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `control`             | container / planned      | `src-brief`, `src-addendum`                                        | `doc-control`                             | The control plane owns routing logic and the placement registry: (tenant, database) resolves to a hosting VM and epoch. The data plane consults that authority; a cached route is only a hint. Moves invalidate stale routes and agent admission rejects stale epochs. The topology is n SQLite files across m VMs, not one VM per database or tenant. Placement is a control-plane decision, but how it selects a VM is an OPEN QUESTION: no placement policy or balancing algorithm is solved here. Creation records active placement only after the selected VM agent confirms provisioning; the registry is then the source of truth. It instructs VM agents for all file work.                                                                                |
| `data`                | container / planned      | `src-brief`, `src-addendum`                                        | `doc-data`                                | Authenticate and authorize the selected database through the control plane; consult control-plane routing and forward queries to the selected VM agent (process). Return agent results. Never read placement metadata or VM files directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `metadata`            | container / planned      | `src-brief`, `src-lanes`, `src-decisions`, `src-addendum`          | `doc-metadata`                            | Proposed Postgres metadata: tenants; databases with unique (tenant_id, name), immutable database_id, state and generation; placement (database_id, owner_node, epoch); durable operation records. Hand-written SQL, no ORM. State transitions use compare-and-swap transactions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `node`                | container / planned      | `src-brief`, `src-lanes`, `src-addendum`                           | `doc-node`                                | Every hosting VM runs a daemon labelled VM agent (process), software, not AI. It is the sole last-mile tenant-file access boundary on that VM. Outside services never access its disk. Its private managed statement-lane workers execute only behind this agent boundary; they expose no independent file or RPC authority. On instruction the agent executes queries and returns results, provisions, opens/closes, suspends/resumes, snapshots/backs up, copies out/receives moves, restores and deletes files, and reports health, size and usage to the control plane.                                                                                                                                                                                        |
| `lanes`               | container / planned      | `src-brief`, `src-lanes`, `src-ffi`, `src-addendum`                | `doc-lanes`                               | Proposed child processes execute statements on node-local database files through the landed FFI layer. Handles, write queues, transactions and idempotency records are keyed by database ID, not tenant. A lane can serve several databases; killing it affects those requests but does not merge file lock domains.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `files`               | container / planned      | `src-brief`, `src-router`, `src-lanes`, `src-addendum`             | `doc-files`                               | Only the hosting VM agent (process) and its private workers access one SQLite database file and its WAL/SHM sidecars per immutable database ID. File paths are server-issued capabilities; user names are not paths. Each file has its own transaction and writer-lock domain. Delete closes handles and removes sidecars too.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `management`          | component / planned      | `src-brief`, `src-addendum`                                        | `doc-management`                          | Authenticates administrators, checks tenant/database management grants and accepts idempotent operation IDs. Returns durable operation status for asynchronous lifecycle requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tenant-registry`     | component / planned      | `src-brief`, `src-addendum`                                        | `doc-tenant-registry`                     | Create, configure, inspect and drop tenants. A tenant owns 0..N database records. Tenant deletion is rejected until every owned database has completed deletion; it never silently abandons files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `database-registry`   | component / planned      | `src-brief`, `src-addendum`                                        | `doc-database-registry`                   | Create/drop databases for a tenant; configure and inspect one database. Resolve tenant-scoped names to immutable IDs. Owns desired state and durable operation records; create starts provisioning, while drop starts lifecycle deletion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `provisioner`         | component / planned      | `src-brief`, `src-lanes`, `src-addendum`                           | `doc-provisioner`                         | The control plane selects a VM; placement policy is an OPEN QUESTION. Reserve identity and non-routable operation intent, instruct its VM agent (process) to create and verify a file, then publish placement only after agent confirmation. Reconcile partial files through the agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lifecycle`           | component / planned      | `src-brief`, `src-lanes`, `src-addendum`                           | `doc-lifecycle`, `doc-lifecycle-policies` | Move, suspend/resume, backup/restore and delete individual databases. Persist operation intent; block opens; fence and drain the source; checkpoint/copy/verify; flip owner and epoch transactionally only after source fencing and target readiness. Require a reachable source to acknowledge fencing in this first design; otherwise leave unavailable. No automatic failover is claimed.                                                                                                                                                                                                                                                                                                                                                                       |
| `ingress`             | component / planned      | `src-brief`, `src-addendum`                                        | `doc-ingress`                             | Stable query API accepts a tenant-scoped database name or ID and session credentials. Carries a request ID, operation IR, compiled SQL/binds and deadline; returns rows or typed errors through the same access path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `authorization`       | component / planned      | `src-brief`, `src-addendum`                                        | `doc-authorization`                       | Authenticate the session and derive trusted tenant identity. Check the requested database belongs to that tenant and is allowed by its grants. Clients cannot supply a trusted tenant, placement epoch or filesystem path. Recheck grants for each database selection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `placement-router`    | component / mixed        | `src-brief`, `src-router`, `src-decisions`, `src-addendum`         | `doc-placement-router`                    | The control plane owns routing logic and the placement registry: (tenant, database) resolves to a hosting VM and epoch. The data plane consults that authority; a cached route is only a hint. Moves invalidate stale routes and agent admission rejects stale epochs. The topology is n SQLite files across m VMs, not one VM per database or tenant. Placement is a control-plane decision, but how it selects a VM is an OPEN QUESTION: no placement policy or balancing algorithm is solved here. Creation records active placement only after the selected VM agent confirms provisioning; the registry is then the source of truth. The landed TenantStorageRouter seam is tenant-only; database-aware ControlPlaneRouter and remote routing remain planned. |
| `forwarder`           | component / planned      | `src-brief`, `src-lanes`, `src-addendum`                           | `doc-forwarder`                           | Send a request to the resolved owner with trusted tenant ID, database ID, epoch, operation IR, SQL/binds, deadline and request ID over authenticated RPC. Return results unchanged. On WrongOwner, refresh and reopen; retries of mutations require per-database request-ID records committed with the mutation. Never blindly replay an ambiguous mutation.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `node-admission`      | component / planned      | `src-brief`, `src-lanes`, `src-storage`, `src-addendum`            | `doc-node-admission`                      | Node-local planned gate validates owner epoch and database state at each admission, including existing sessions. Per-database quiescing blocks new requests, drains or cancels in-flight work, closes all read/write handles and acknowledges a fence. If a lane must be killed, wait for process exit and fail affected requests; do not claim a fence while an old writer can still run.                                                                                                                                                                                                                                                                                                                                                                         |
| `classifier`          | component / existing     | `src-classifier`, `src-lanes`, `src-addendum`                      | `doc-classifier`                          | Existing platform/sqlite_ffi/classify.ts classifies operation IR, not SQL text: bounded plans use blocking execution; unbounded reads use nonblocking execution. Reused unchanged inside proposed lanes; moving it into a lane is not landed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `execution`           | component / existing     | `src-ffi`, `src-storage`, `src-lanes`, `src-addendum`              | `doc-execution`                           | Existing Deno FFI to system libsqlite3: scoped connections, prepared statements, blocking/nonblocking steps and binding. Reused unchanged in proposed lanes; no separate libsqlite3 container. Deadline wrapper interrupts long reads and waits for execution to settle before reusing the connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `deadline`            | component / mixed        | `src-ffi`, `src-storage`, `src-lanes`, `src-brief`, `src-addendum` | `doc-deadline`                            | Existing deadline/interrupt behavior is reused; proposed lane watchdog adds supervisor escalation if interruption does not settle. A process kill affects every in-flight request on that lane. Per-database drain acknowledgement waits for completion or confirmed process exit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dep-gateway`         | deploymentNode / planned | `src-brief`, `src-addendum`                                        | `doc-dep-gateway`                         | Illustrative proposed host; not a claim about the actual droplet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dep-management`      | deploymentNode / planned | `src-brief`, `src-addendum`                                        | `doc-dep-management`                      | Illustrative proposed host; not a claim about the actual droplet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dep-postgres`        | deploymentNode / planned | `src-brief`, `src-addendum`                                        | `doc-dep-postgres`                        | Illustrative proposed host; not a claim about the actual droplet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dep-a`               | deploymentNode / planned | `src-brief`, `src-addendum`                                        | `doc-dep-a`                               | Illustrative proposed host; not a claim about the actual droplet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dep-b`               | deploymentNode / planned | `src-brief`, `src-addendum`                                        | `doc-dep-b`                               | Illustrative proposed host; not a claim about the actual droplet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dep-c`               | deploymentNode / planned | `src-brief`, `src-addendum`                                        | `doc-dep-c`                               | Illustrative proposed host; not a claim about the actual droplet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dep-query`           | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-query`                           | Illustrative proposed instance. One stable query access path for all tenant databases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `dep-control`         | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-control`                         | Illustrative proposed instance. Tenant and database lifecycle requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `dep-metadata`        | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-metadata`                        | Illustrative proposed instance. Database-keyed owner and epoch records; handwritten SQL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dep-a-agent`         | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-a-agent`                         | Illustrative proposed instance. Owns Alpha/orders, Alpha/archive and Beta/metrics (three databases).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `dep-b-agent`         | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-b-agent`                         | Illustrative proposed instance. Owns Alpha/analytics (one database).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `dep-c-agent`         | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-c-agent`                         | Illustrative proposed instance. Owns Beta/sandbox and Gamma/events (two databases).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dep-a-lane`          | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-a-lane`                          | Illustrative proposed instance. Illustrative lane; per-database file handles and queues.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dep-b-lane`          | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-b-lane`                          | Illustrative proposed instance. Illustrative lane for Alpha/analytics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `dep-c-lane`          | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-c-lane`                          | Illustrative proposed instance. Illustrative lane; Beta and Gamma remain separate files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dep-alpha-orders`    | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-alpha-orders`                    | Illustrative proposed instance. Tenant Alpha database orders: immutable db-a1; independent file and lock domain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `dep-alpha-archive`   | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-alpha-archive`                   | Illustrative proposed instance. Tenant Alpha database archive: immutable db-a2; independent file and lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `dep-beta-metrics`    | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-beta-metrics`                    | Illustrative proposed instance. Tenant Beta database metrics: immutable db-b1; shares node A, not a file, with Alpha.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dep-alpha-analytics` | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-alpha-analytics`                 | Illustrative proposed instance. Tenant Alpha database analytics: immutable db-a3; same endpoint as Alpha databases on A.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `dep-beta-sandbox`    | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-beta-sandbox`                    | Illustrative proposed instance. Tenant Beta database sandbox: immutable db-b2 on a different node from metrics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `dep-gamma-events`    | instance / planned       | `src-brief`, `src-addendum`                                        | `doc-dep-gamma-events`                    | Illustrative proposed instance. Tenant Gamma database events: immutable db-c1; separate from Beta/sandbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Relationships

| ID                                   | Endpoints                             | Status   | Sources / logical instance                            | Grounding                                                                        |
| ------------------------------------ | ------------------------------------- | -------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ctx-manage`                         | `operator` → `platform`               | planned  | `src-brief`, `src-addendum`                           | Management path → control plane: tenant and database CRUD / lifecycle            |
| `ctx-query`                          | `caller` → `platform`                 | planned  | `src-brief`, `src-addendum`                           | Query path → data plane: dynamically access any authorized database              |
| `ctx-backup`                         | `platform` → `backups`                | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Per-database verified backup / restore; optional WAL frames later                |
| `c-manage`                           | `operator` → `control`                | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Manage tenants and databases                                                     |
| `c-query`                            | `caller` → `data`                     | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Select any authorized database and query it                                      |
| `c-catalog`                          | `control` → `metadata`                | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Tenant/database CRUD, operation state and placement publication                  |
| `c-resolve`                          | `data` → `control`                    | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Consult control-plane routing and database authorization                         |
| `c-lifecycle`                        | `control` → `node`                    | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Provision, fence, drain, copy, delete one database                               |
| `c-forward`                          | `data` → `node`                       | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Execute on owner: tenant ID, database ID, epoch, request ID, plan, SQL, deadline |
| `c-lane`                             | `node` → `lanes`                      | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Admit database-scoped work; supervise child processes                            |
| `c-files`                            | `node` → `files`                      | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Sole tenant-file access boundary: execute through managed FFI workers            |
| `c-node-files`                       | `node` → `files`                      | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Provision, verify, snapshot, restore and remove database files                   |
| `c-node-backup`                      | `node` → `backups`                    | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Publish or fetch verified per-database snapshot                                  |
| `cp-request`                         | `operator` → `management`             | planned  | `src-brief`, `src-addendum`                           | Authorized management request and operation status                               |
| `cp-tenant`                          | `management` → `tenant-registry`      | planned  | `src-brief`, `src-addendum`                           | Create / drop tenant; configure / inspect                                        |
| `cp-database`                        | `management` → `database-registry`    | planned  | `src-brief`, `src-addendum`                           | Create / drop tenant database; configure / inspect                               |
| `cp-tenants-sql`                     | `tenant-registry` → `metadata`        | planned  | `src-brief`, `src-addendum`                           | Tenant records; refuse deletion while databases remain                           |
| `cp-databases-sql`                   | `database-registry` → `metadata`      | planned  | `src-brief`, `src-addendum`                           | Database names / IDs, desired state and idempotent operation records             |
| `cp-provision`                       | `database-registry` → `provisioner`   | planned  | `src-brief`, `src-addendum`                           | Reconcile a new database                                                         |
| `cp-lifecycle`                       | `database-registry` → `lifecycle`     | planned  | `src-brief`, `src-addendum`                           | Move, suspend/resume, backup/restore or drop one database                        |
| `cp-placement`                       | `provisioner` → `metadata`            | planned  | `src-brief`, `src-addendum`                           | Reserve identity and node; publish ACTIVE placement after readiness              |
| `cp-create-file`                     | `provisioner` → `node`                | planned  | `src-brief`, `src-addendum`                           | Create and verify one database file on selected node                             |
| `cp-operation`                       | `lifecycle` → `metadata`              | planned  | `src-brief`, `src-addendum`                           | Persist state / tombstone; atomically change owner and epoch                     |
| `cp-node`                            | `lifecycle` → `node`                  | planned  | `src-brief`, `src-addendum`                           | Fence, quiesce, copy/verify, activate or delete addressed database               |
| `dp-request`                         | `caller` → `ingress`                  | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Query a named database using the same session and endpoint                       |
| `dp-auth`                            | `ingress` → `authorization`           | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Authenticate session and authorize tenant / database selection                   |
| `dp-auth-sql`                        | `authorization` → `database-registry` | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Consult control plane: resolve name and verify tenant ownership / grants         |
| `dp-route`                           | `authorization` → `placement-router`  | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Resolve authorized database at open; refresh after relocation                    |
| `dp-placement`                       | `placement-router` → `metadata`       | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Read ACTIVE database → node and epoch; reject inactive state                     |
| `dp-forward`                         | `placement-router` → `forwarder`      | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Trusted database location and epoch for this request                             |
| `dp-owner`                           | `forwarder` → `node-admission`        | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Owner-node request or WrongOwner / inactive response                             |
| `dp-classify`                        | `node-admission` → `classifier`       | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Admit and classify operation IR in a selected lane                               |
| `dp-execute`                         | `classifier` → `execution`            | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Choose bounded blocking or unbounded nonblocking step                            |
| `dp-deadline`                        | `execution` → `deadline`              | mixed    | `src-ffi`, `src-storage`, `src-brief`, `src-addendum` | Apply deadline policy and settle interrupted step                                |
| `dp-interrupt`                       | `deadline` → `execution`              | mixed    | `src-ffi`, `src-lanes`, `src-addendum`                | Interrupt at deadline; escalate if step does not settle                          |
| `dp-escalate`                        | `deadline` → `node-admission`         | planned  | `src-brief`, `src-lanes`, `src-addendum`              | Ask supervisor to kill stuck lane; wait for confirmed exit                       |
| `dp-files`                           | `execution` → `files`                 | existing | `src-ffi`, `src-router`, `src-addendum`               | Read / write only the selected database SQLite file                              |
| `dep-control-to-dep-metadata`        | `dep-control` → `dep-metadata`        | planned  | `src-brief`, `src-addendum` / `c-catalog`             | Tenant/database CRUD, operation state and placement publication                  |
| `dep-query-to-dep-control`           | `dep-query` → `dep-control`           | planned  | `src-brief`, `src-addendum` / `c-resolve`             | Consult control-plane routing and database authorization                         |
| `dep-query-to-dep-a-agent`           | `dep-query` → `dep-a-agent`           | planned  | `src-brief`, `src-addendum` / `c-forward`             | Execute on owner: tenant ID, database ID, epoch, request ID, plan, SQL, deadline |
| `dep-query-to-dep-b-agent`           | `dep-query` → `dep-b-agent`           | planned  | `src-brief`, `src-addendum` / `c-forward`             | Execute on owner: tenant ID, database ID, epoch, request ID, plan, SQL, deadline |
| `dep-query-to-dep-c-agent`           | `dep-query` → `dep-c-agent`           | planned  | `src-brief`, `src-addendum` / `c-forward`             | Execute on owner: tenant ID, database ID, epoch, request ID, plan, SQL, deadline |
| `dep-control-to-dep-a-agent`         | `dep-control` → `dep-a-agent`         | planned  | `src-brief`, `src-addendum` / `c-lifecycle`           | Provision, fence, drain, copy, delete one database                               |
| `dep-control-to-dep-b-agent`         | `dep-control` → `dep-b-agent`         | planned  | `src-brief`, `src-addendum` / `c-lifecycle`           | Provision, fence, drain, copy, delete one database                               |
| `dep-control-to-dep-c-agent`         | `dep-control` → `dep-c-agent`         | planned  | `src-brief`, `src-addendum` / `c-lifecycle`           | Provision, fence, drain, copy, delete one database                               |
| `dep-a-agent-to-dep-a-lane`          | `dep-a-agent` → `dep-a-lane`          | planned  | `src-brief`, `src-addendum` / `c-lane`                | Admit database-scoped work; supervise child processes                            |
| `dep-b-agent-to-dep-b-lane`          | `dep-b-agent` → `dep-b-lane`          | planned  | `src-brief`, `src-addendum` / `c-lane`                | Admit database-scoped work; supervise child processes                            |
| `dep-c-agent-to-dep-c-lane`          | `dep-c-agent` → `dep-c-lane`          | planned  | `src-brief`, `src-addendum` / `c-lane`                | Admit database-scoped work; supervise child processes                            |
| `dep-a-agent-to-dep-alpha-orders`    | `dep-a-agent` → `dep-alpha-orders`    | planned  | `src-brief`, `src-addendum` / `c-files`               | Sole tenant-file access boundary: execute through managed FFI workers            |
| `dep-a-agent-to-dep-alpha-archive`   | `dep-a-agent` → `dep-alpha-archive`   | planned  | `src-brief`, `src-addendum` / `c-files`               | Sole tenant-file access boundary: execute through managed FFI workers            |
| `dep-a-agent-to-dep-beta-metrics`    | `dep-a-agent` → `dep-beta-metrics`    | planned  | `src-brief`, `src-addendum` / `c-files`               | Sole tenant-file access boundary: execute through managed FFI workers            |
| `dep-b-agent-to-dep-alpha-analytics` | `dep-b-agent` → `dep-alpha-analytics` | planned  | `src-brief`, `src-addendum` / `c-files`               | Sole tenant-file access boundary: execute through managed FFI workers            |
| `dep-c-agent-to-dep-beta-sandbox`    | `dep-c-agent` → `dep-beta-sandbox`    | planned  | `src-brief`, `src-addendum` / `c-files`               | Sole tenant-file access boundary: execute through managed FFI workers            |
| `dep-c-agent-to-dep-gamma-events`    | `dep-c-agent` → `dep-gamma-events`    | planned  | `src-brief`, `src-addendum` / `c-files`               | Sole tenant-file access boundary: execute through managed FFI workers            |

## Views and steps

Each step below inherits its diagram’s `src-brief` / `src-lanes` / `src-addendum` provenance. The authored
labels specify the proposed protocol; only the identified classifier/FFI operations are landed. Diagrams link
their alternatives and parent views.

### `planes-context` — context

Document: `doc-planes-context`. Status: planned.

Members: `operator`, `caller`, `platform`, `backups`.

Edges: `ctx-manage`, `ctx-query`, `ctx-backup`.

### `planes-containers` — container

Document: `doc-planes-containers`. Status: planned.

Members: `operator`, `caller`, `control`, `data`, `metadata`, `node`, `lanes`, `files`, `backups`.

Edges: `c-manage`, `c-query`, `c-catalog`, `c-resolve`, `c-lifecycle`, `c-forward`, `c-lane`, `c-files`,
`c-node-files`, `c-node-backup`.

### `planes-control-components` — component

Document: `doc-planes-control-components`. Status: planned.

Members: `operator`, `management`, `tenant-registry`, `database-registry`, `provisioner`, `lifecycle`,
`placement-router`, `metadata`, `node`.

Edges: `cp-request`, `cp-tenant`, `cp-database`, `cp-tenants-sql`, `cp-databases-sql`, `cp-provision`,
`cp-lifecycle`, `cp-placement`, `cp-create-file`, `cp-operation`, `cp-node`, `dp-placement`.

### `planes-data-components` — component

Document: `doc-planes-data-components`. Status: planned.

Members: `caller`, `ingress`, `authorization`, `placement-router`, `forwarder`, `database-registry`,
`metadata`, `node-admission`, `classifier`, `execution`, `deadline`, `files`.

Edges: `dp-request`, `dp-auth`, `dp-auth-sql`, `dp-route`, `dp-placement`, `dp-forward`, `dp-owner`,
`dp-classify`, `dp-execute`, `dp-deadline`, `dp-interrupt`, `dp-escalate`, `dp-files`.

### `flow-create-database` — dynamic

Document: `doc-flow-create-database`. Status: planned.

Step root `flow-create-database-sequence`: sequence.

| Step ID                    | Relationship / direction     | Label / grounding                                                                    |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `flow-create-database-s1`  | `cp-request` / forward       | Create database for tenant, with operation ID                                        |
| `flow-create-database-s2`  | `cp-database` / forward      | Authorize and register requested database name                                       |
| `flow-create-database-s3`  | `cp-databases-sql` / forward | Reserve immutable database ID and unique name; persist PROVISIONING operation        |
| `flow-create-database-s4`  | `cp-provision` / forward     | Start idempotent provisioning for database ID                                        |
| `flow-create-database-s5`  | `cp-placement` / forward     | Control plane selects VM (placement policy OPEN); reserve non-routable intent        |
| `flow-create-database-s6`  | `cp-create-file` / forward   | Instruct selected VM agent (process) to provision file/schema under generation token |
| `flow-create-database-s7`  | `cp-create-file` / reverse   | VM agent (process) confirms verified file readiness                                  |
| `flow-create-database-s8`  | `cp-placement` / forward     | CAS operation generation: publish ACTIVE owner and initial epoch atomically          |
| `flow-create-database-s9`  | `cp-provision` / reverse     | Return successful operation state                                                    |
| `flow-create-database-s10` | `cp-database` / reverse      | Return database ID and operation status                                              |
| `flow-create-database-s11` | `cp-request` / reverse       | Report ACTIVE database through management endpoint                                   |

### `flow-create-failed` — dynamic

Document: `doc-flow-create-failed`. Status: planned.

Step root `flow-create-failed-sequence`: sequence.

| Step ID                 | Relationship / direction   | Label / grounding                                                 |
| ----------------------- | -------------------------- | ----------------------------------------------------------------- |
| `flow-create-failed-s1` | `cp-provision` / forward   | Resume durable PROVISIONING operation                             |
| `flow-create-failed-s2` | `cp-create-file` / forward | Attempt file/schema creation                                      |
| `flow-create-failed-s3` | `cp-create-file` / reverse | Creation or verification fails; no readiness acknowledgement      |
| `flow-create-failed-s4` | `cp-placement` / forward   | Keep placement non-routable; record cleanup-required operation    |
| `flow-create-failed-s5` | `cp-create-file` / forward | Retry idempotent removal of partial file and sidecars             |
| `flow-create-failed-s6` | `cp-create-file` / reverse | Acknowledge no partial file remains                               |
| `flow-create-failed-s7` | `cp-placement` / forward   | Record FAILED operation; release reserved name only after cleanup |
| `flow-create-failed-s8` | `cp-provision` / reverse   | Return failed operation status                                    |

### `flow-query-right-node` — dynamic

Document: `doc-flow-query-right-node`. Status: planned.

Step root `flow-query-right-node-sequence`: sequence.

| Step ID                     | Relationship / direction | Label / grounding                                                             |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `flow-query-right-node-s1`  | `dp-request` / forward   | Session selects one tenant database by name or ID                             |
| `flow-query-right-node-s2`  | `dp-auth` / forward      | Authenticate and authorize this selection                                     |
| `flow-query-right-node-s3`  | `dp-auth-sql` / forward  | Verify database belongs to trusted tenant and grants allow access             |
| `flow-query-right-node-s4`  | `dp-auth-sql` / reverse  | Return authorized immutable database ID                                       |
| `flow-query-right-node-s5`  | `dp-route` / forward     | Resolve location at open for this database                                    |
| `flow-query-right-node-s6`  | `dp-placement` / forward | Control-plane routing reads authoritative ACTIVE VM and epoch                 |
| `flow-query-right-node-s7`  | `dp-placement` / reverse | Return node B and current epoch; client need not know node B                  |
| `flow-query-right-node-s8`  | `dp-forward` / forward   | Use trusted placement and preserve request identity                           |
| `flow-query-right-node-s9`  | `dp-owner` / forward     | Forward tenant/database IDs, epoch, plan IR, SQL/binds and deadline to node B |
| `flow-query-right-node-s10` | `dp-classify` / forward  | Admit only current ACTIVE epoch and send IR to node-local lane                |
| `flow-query-right-node-s11` | `dp-execute` / forward   | Choose the execution path from the operation IR                               |
| `flow-query-right-node-s12` | `dp-deadline` / forward  | Apply execution deadline policy                                               |
| `flow-query-right-node-s13` | `dp-files` / forward     | Execute against this database file                                            |
| `flow-query-right-node-s14` | `dp-files` / reverse     | Return rows after statement settles                                           |
| `flow-query-right-node-s15` | `dp-execute` / reverse   | Return completed execution result                                             |
| `flow-query-right-node-s16` | `dp-classify` / reverse  | Return lane result to node admission                                          |
| `flow-query-right-node-s17` | `dp-owner` / reverse     | Return rows to forwarding gateway                                             |
| `flow-query-right-node-s18` | `dp-forward` / reverse   | Return result through router                                                  |
| `flow-query-right-node-s19` | `dp-route` / reverse     | Return result through authorization                                           |
| `flow-query-right-node-s20` | `dp-auth` / reverse      | Return result to query ingress                                                |
| `flow-query-right-node-s21` | `dp-request` / reverse   | Return rows to the same client session                                        |

### `flow-query-stale` — dynamic

Document: `doc-flow-query-stale`. Status: planned.

Step root `flow-query-stale-sequence`: sequence.

| Step ID               | Relationship / direction | Label / grounding                                                     |
| --------------------- | ------------------------ | --------------------------------------------------------------------- |
| `flow-query-stale-s1` | `dp-owner` / forward     | Send request with old epoch to former owner                           |
| `flow-query-stale-s2` | `dp-owner` / reverse     | Reject before executing: WrongOwner / stale epoch                     |
| `flow-query-stale-s3` | `dp-forward` / reverse   | Invalidate cached database location                                   |
| `flow-query-stale-s4` | `dp-placement` / forward | Consult control-plane routing again for ACTIVE database VM and epoch  |
| `flow-query-stale-s5` | `dp-placement` / reverse | Return new owner and epoch after completed move                       |
| `flow-query-stale-s6` | `dp-forward` / forward   | Reopen database location at new owner                                 |
| `flow-query-stale-s7` | `dp-owner` / forward     | Retry safely with same request ID at new owner; no client node change |
| `flow-query-stale-s8` | `dp-owner` / reverse     | Return result or recorded per-database mutation outcome               |

### `flow-query-deadline` — dynamic

Document: `doc-flow-query-deadline`. Status: planned.

Step root `flow-query-deadline-sequence`: sequence.

| Step ID                  | Relationship / direction | Label / grounding                                   |
| ------------------------ | ------------------------ | --------------------------------------------------- |
| `flow-query-deadline-s1` | `dp-execute` / forward   | Classified unbounded read uses nonblocking FFI step |
| `flow-query-deadline-s2` | `dp-deadline` / forward  | Apply remaining read deadline                       |
| `flow-query-deadline-s3` | `dp-interrupt` / forward | Deadline expires: interrupt the read                |
| `flow-query-deadline-s4` | `dp-interrupt` / reverse | Confirm step settled before connection reuse        |
| `flow-query-deadline-s5` | `dp-execute` / reverse   | Return typed deadline failure                       |

### `flow-move-database` — dynamic

Document: `doc-flow-move-database`. Status: planned.

Step root `flow-move-database-sequence`: sequence.

| Step ID                  | Relationship / direction | Label / grounding                                                                                                                     |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `flow-move-database-s1`  | `cp-lifecycle` / forward | Request move of one database A → B with operation ID                                                                                  |
| `flow-move-database-s2`  | `cp-operation` / forward | CAS ACTIVE → MOVING; persist source A, target B and next epoch; block new opens                                                       |
| `flow-move-database-s3`  | `cp-node` / forward      | Fence this database on source A; stop all new admissions including existing sessions                                                  |
| `flow-move-database-s4`  | `cp-node` / forward      | Drain or cancel in-flight work; close all handles; checkpoint after settlement                                                        |
| `flow-move-database-s5`  | `cp-node` / reverse      | Source A confirms durable fence and no live database handles / writers                                                                |
| `flow-move-database-s6`  | `cp-node` / forward      | Instruct source VM agent (process) to copy out to target VM agent (process); target receives and verifies snapshot / request-ID state |
| `flow-move-database-s7`  | `cp-node` / reverse      | Target VM agent (process) confirms verified staged data and readiness; source agent stays fenced                                      |
| `flow-move-database-s8`  | `cp-operation` / forward | Transaction CAS MOVING operation: flip owner A → B, increment epoch and publish ACTIVE                                                |
| `flow-move-database-s9`  | `cp-node` / forward      | Activate target B only after reading new ACTIVE owner / epoch; old epoch stays rejected                                               |
| `flow-move-database-s10` | `cp-node` / reverse      | Target B accepts current-epoch access                                                                                                 |
| `flow-move-database-s11` | `cp-node` / forward      | Remove fenced source copy and sidecars; reconcile cleanup if needed                                                                   |
| `flow-move-database-s12` | `cp-operation` / forward | Record move complete; keep epoch and operation history                                                                                |
| `flow-move-database-s13` | `cp-lifecycle` / reverse | Report completed move; stale routing will refresh at open                                                                             |

### `flow-move-failed` — dynamic

Document: `doc-flow-move-failed`. Status: planned.

Step root `flow-move-failed-sequence`: sequence.

| Step ID               | Relationship / direction | Label / grounding                                                                        |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `flow-move-failed-s1` | `cp-node` / reverse      | Source fence confirmed; staged target copy fails integrity check                         |
| `flow-move-failed-s2` | `cp-operation` / forward | Keep MOVING unavailable and source owner unchanged; record failed attempt                |
| `flow-move-failed-s3` | `cp-node` / forward      | Remove inactive target copy; require confirmed cleanup                                   |
| `flow-move-failed-s4` | `cp-node` / reverse      | Confirm target cannot serve and its staged copy is removed                               |
| `flow-move-failed-s5` | `cp-operation` / forward | CAS rollback: publish source A ACTIVE at a fresh epoch; retain operation failure history |
| `flow-move-failed-s6` | `cp-node` / forward      | Explicitly unfence A only after reading rollback ACTIVE epoch                            |
| `flow-move-failed-s7` | `cp-lifecycle` / reverse | Return failed move status; source can serve refreshed opens                              |

### `flow-drop-database` — dynamic

Document: `doc-flow-drop-database`. Status: planned.

Step root `flow-drop-database-sequence`: sequence.

| Step ID                  | Relationship / direction | Label / grounding                                                                                                     |
| ------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `flow-drop-database-s1`  | `cp-request` / forward   | Drop tenant database by ID with operation ID                                                                          |
| `flow-drop-database-s2`  | `cp-database` / forward  | Authorize database deletion                                                                                           |
| `flow-drop-database-s3`  | `cp-lifecycle` / forward | Start durable database delete operation                                                                               |
| `flow-drop-database-s4`  | `cp-operation` / forward | CAS state → DROPPING; tombstone identity and block opens                                                              |
| `flow-drop-database-s5`  | `cp-node` / forward      | Fence owner and drain/cancel work; close read/write handles on all known copies                                       |
| `flow-drop-database-s6`  | `cp-node` / reverse      | Confirm no in-flight work, live handles or old copies can serve                                                       |
| `flow-drop-database-s7`  | `cp-node` / forward      | Instruct hosting VM agent (process) to remove file, sidecars, remnants and backups / WAL archives                     |
| `flow-drop-database-s8`  | `cp-node` / reverse      | VM agent (process) confirms all database data and backups removed                                                     |
| `flow-drop-database-s9`  | `cp-operation` / forward | Remove active placement and live database/name registry records; retain non-routable ID tombstone and operation audit |
| `flow-drop-database-s10` | `cp-lifecycle` / reverse | Report database deletion complete                                                                                     |
| `flow-drop-database-s11` | `cp-database` / reverse  | Return completed drop status                                                                                          |
| `flow-drop-database-s12` | `cp-request` / reverse   | Acknowledge deletion; tenant and sibling databases remain                                                             |

### `flow-drop-failed` — dynamic

Document: `doc-flow-drop-failed`. Status: planned.

Step root `flow-drop-failed-sequence`: sequence.

| Step ID               | Relationship / direction | Label / grounding                                                                         |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `flow-drop-failed-s1` | `cp-node` / forward      | Attempt idempotent removal after fencing and drain                                        |
| `flow-drop-failed-s2` | `cp-node` / reverse      | Node unavailable or file/backup cleanup not confirmed                                     |
| `flow-drop-failed-s3` | `cp-operation` / forward | Retain DROPPING tombstone, placement evidence and pending cleanup operation; deny queries |
| `flow-drop-failed-s4` | `cp-lifecycle` / reverse | Report deletion pending, not successful; reconcile cleanup with same operation ID         |

### `planes-deployment` — deployment

Document: `doc-planes-deployment`. Status: planned.

Members: `dep-gateway`, `dep-management`, `dep-postgres`, `dep-a`, `dep-b`, `dep-c`, `dep-query`,
`dep-control`, `dep-metadata`, `dep-a-agent`, `dep-b-agent`, `dep-c-agent`, `dep-a-lane`, `dep-b-lane`,
`dep-c-lane`, `dep-alpha-orders`, `dep-alpha-archive`, `dep-beta-metrics`, `dep-alpha-analytics`,
`dep-beta-sandbox`, `dep-gamma-events`.

Edges: `dep-control-to-dep-metadata`, `dep-query-to-dep-control`, `dep-query-to-dep-a-agent`,
`dep-query-to-dep-b-agent`, `dep-query-to-dep-c-agent`, `dep-control-to-dep-a-agent`,
`dep-control-to-dep-b-agent`, `dep-control-to-dep-c-agent`, `dep-a-agent-to-dep-a-lane`,
`dep-b-agent-to-dep-b-lane`, `dep-c-agent-to-dep-c-lane`, `dep-a-agent-to-dep-alpha-orders`,
`dep-a-agent-to-dep-alpha-archive`, `dep-a-agent-to-dep-beta-metrics`, `dep-b-agent-to-dep-alpha-analytics`,
`dep-c-agent-to-dep-beta-sandbox`, `dep-c-agent-to-dep-gamma-events`.

## Learning preservation handoff

The database-aware router caveat (DP4), offline relocation safety conditions (DP7), and shared-lane blast
radius (DP9) are durable design findings. This inventory preserves them within builder ownership. Coordinator:
link this inventory from `docs/knowledge/decisions.md` / `index.md` after review; those files are outside this
unit’s Owns set. No reusable general-purpose script was discovered: `build-dataset.py` is a unit-specific
authoring source, not a work-scripts building block.
