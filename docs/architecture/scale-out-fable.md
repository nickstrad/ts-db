# Scale-out ranking (Fable)

Status: proposed · Author: Fable 5.1 (with nickstrad) · Date: 2026-10-12 · Branch: `arch/fable-ranking` ·
Baseline read: `main` at `e808983`.

This document has two parts written in a fixed order. Part 1 is an independent design pass, written and
committed **before** reading the Opus and Astra scale-out documents, so it cannot be anchored on them. Part 2
reviews those documents and produces the final ranking across every approach, including the one proposed here.

---

## Part 1 — Independent pass

### 1.1 The problem, restated against the code

Today one server process holds every SQLite handle and funnels all work through a few shared paths. The
contention is not one thing; it is four, and they sit at different layers:

| # | Shared path on `main` (`e808983`)                                                                                                                  | Where                                                 | What it costs                                                                                                                                                                                  |
| - | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | **One event loop.** `node:sqlite` is synchronous; every statement blocks the whole process.                                                        | `platform/sqlite.ts`, `platform/document_reader.ts`   | A 200 ms query for tenant A stalls tenant B's write for 200 ms even though they use different files and different semaphores. This is the actual noisy-neighbour path; the semaphores are not. |
| 2 | **One global read semaphore** (32 permits) and one 1000-deep admission cap shared by all tenants.                                                  | `DOCUMENT_READ_CONCURRENCY_CAP`, `DEFAULT_READER_CAP` | One tenant issuing 1000 slow reads fills the cap; everyone else gets `QueueFullError` (503).                                                                                                   |
| 3 | **Backups take the per-file write lock.** `Storage.snapshot` (`VACUUM INTO`) runs on the writer's `Semaphore(1)`.                                  | `platform/sqlite.ts:616`, `platform/backup.ts:10`     | For the duration of a snapshot that file accepts no mutations. On a big file that is seconds, which is exactly what a once-a-minute hot write must never wait behind.                          |
| 4 | **One handle table.** Tenant-mode writers sit in a 64-entry LRU with 60 s idle expiry; document reads open a fresh read-only connection per query. | `platform/sqlite.ts:664`, `document_reader.ts:105`    | Handle count is bounded, but every file lives on one node's disk, so the node is the ceiling for the working set, not just for descriptors.                                                    |

Measured on this VM (2026-10-12, scratch script, `deno run -A`): a WAL writer connection costs **3** file
descriptors (db, `-wal`, `-shm`) and a read-only connection costs **2**. `ulimit -n` here is 1,048,576, so the
brief's descriptor ceiling is a thought experiment on this box, but the arithmetic is what matters: a node's
usable file budget is roughly `(nofile − baseline) / 5` tenants with one writer and one pooled reader each.

### 1.2 Reading the three constraints honestly

1. **"One more file than a node can hold."** Taken literally, the 64-entry LRU already landed in MT-04
   satisfies this: nothing requires every file to be open at once. So an LRU alone is a non-answer to a
   scale-out brief. The useful reading is _the working set exceeds one node_, which means at least two nodes
   and a rule for which node owns which file. That rule is the whole design.
2. **"A hot write every minute, never starved."** Starvation has three sources here: reads ahead of it in a
   shared queue (path 2), a synchronous statement from another tenant blocking the loop (path 1), and a backup
   holding its own file's write lock (path 3). A design must close all three, not just add a "write lane".
3. **"No single read or write blocks everyone."** With a synchronous driver on one loop, the only real
   bulkhead is a separate event loop: a worker or a process. Admission caps bound _queueing_, not _blocking_.

### 1.3 The design space, briefly

Four families cover it. I list them to show what I rejected and why, not to pad the ranking.

- **Replicate every file to every node.** Removes placement, but needs a consensus or single-writer protocol
  per file and multiplies disk by node count. SQLite's single-writer model makes "any node writes" a lie.
- **Consistent-hash the tenant id to a node.** Cheap to describe, wrong for data with gravity: a ring change
  moves files, not hash slots, and a file move is a copy-plus-cutover. Hashing also cannot express "this
  tenant is hot, give it its own node".
- **Explicit placement in a control plane, data nodes own files.** The Turso/Convex shape: a registry says
  which node owns which tenant; the owning node is the only writer; reads either go to the owner or to a
  replica. This matches what the repo already has (Postgres tenant registry, `TenantStorageRouter` seam
  reserved for `"control-plane"`).
- **Durable command log, nodes replay.** Clean on paper, but it rebuilds a database engine's job on top of
  SQLite: ordering, idempotency, snapshots, and a second source of truth for every write.

The third family is the one I would build. What follows is the specific shape.

### 1.4 Proposal F — placement-routed tenant cells with worker bulkheads

Label: **new as a whole, assembled from three modifications of existing seams**. Nothing in it requires a new
consensus system or a new storage engine.

```text
                 ┌────────────────────────────────────────────────────┐
  client ──────► │ any ts-db node: HTTP + auth (unchanged)            │
                 │ TenantContext from credential (MT-07, unchanged)   │
                 │ PlacementRouter: tenant → owner node  (NEW, cached)│
                 └──────────────┬──────────────────────┬──────────────┘
                 local owner?   │ yes               no │ forward (HTTP, same request, X-Forwarded-Tenant)
                                ▼                      ▼
                 ┌─────────────────────────┐    ┌─────────────────────────┐
                 │ node A (data plane)     │    │ node B (data plane)     │
                 │ main loop: HTTP only    │    │ ...                     │
                 │ worker lanes 0..k-1     │    │                         │
                 │  tenant → lane (sticky) │    │                         │
                 │  lane = own event loop, │    │                         │
                 │  own LRU, own read pool,│    │                         │
                 │  write-first scheduler  │    │                         │
                 │ reader child (DuckDB)   │    │                         │
                 └────────────┬────────────┘    └─────────────────────────┘
                              │ backups (read connection) + WAL frames
                              ▼
                      object store (existing ObjectStoreLive)

  control plane = Postgres (existing): tenants, api_keys, + placement(tenant_id, node_id, epoch, state)
```

**F1. Placement lives in Postgres, next to the tenant row.** A `placement` table maps `tenant_id → node_id`
with an `epoch` and a `state` (`active`, `moving`, `frozen`). Nodes register themselves in a `nodes` table
with capacity (`max_tenants`, derived from `nofile / 5` with headroom) and a heartbeat. New tenants are placed
on the least-loaded live node at creation time by the admin path that already creates tenants (MT-05). This is
the `ControlPlaneRouter` the MT-04 seam reserved; `tenantRouter: "control-plane"` selects it. There is no new
service to operate: the registry the server already caches (hashed keys, 30 s TTL) gains one more cached
column. A stale cache is safe because a node that receives a tenant it does not own answers with a typed
`WrongOwner` carrying the epoch, and the forwarder refreshes and retries once.

**F2. Any node fronts, the owner executes.** Auth stays on the receiving node (it already derives the tenant
from the credential, never from the request). If the placement says "me", the request runs locally; otherwise
it is forwarded over HTTP to the owner with the resolved tenant id in a trusted internal header, the same
trust model MT-07 uses for reader IPC. Forwarding beats redirecting because the client surface and the
`createClient(baseURL, appId, token)` signature stay unchanged, and because the forward hop is one loopback or
LAN round trip against a p50 of 4 ms. A later optimisation can hand clients a per-tenant base URL; it is not
needed to satisfy the constraints.

**F3. Inside a node, tenants are sharded across worker lanes.** This is the part the measured facts drive. The
main thread keeps HTTP, auth and forwarding, and never calls `node:sqlite`. `k` Web Workers (one per core,
minus one for the main loop and one for the DuckDB child) each own their own event loop, a tenant-keyed LRU of
writer handles, a tenant-keyed pool of read-only handles, and a scheduler. A tenant maps to one lane by
`hash(tenant_id) mod k` for the node's lifetime (sticky), so one tenant's slow statement can only stall the
tenants on its lane, never the node. Verified on this VM: a worker ran a 1.9 s SQLite query while the main
loop kept ticking every 10 ms. The existing per-file `Semaphore(1)` and `BEGIN IMMEDIATE` discipline move into
the lane unchanged; the existing reader child and its IPC stay as they are.

**F4. Writes are never behind reads, in three places.** (a) Each lane runs a two-level scheduler: a mutation
for file X waits only on X's own write lock, never on the lane's read permits; reads take permits from a
per-lane pool and a per-tenant sub-cap (`min(lane_cap / tenants_on_lane, 8)` by default), so one tenant cannot
drain the lane's read permits. (b) The admission cap becomes per tenant, not global, so one tenant's 1000
pending reads produce 503s for that tenant only. (c) `Storage.snapshot` moves off the writer queue onto a
dedicated read-only connection; WAL mode allows `VACUUM INTO` from a reader while the writer continues, and
the snapshot is still a consistent read transaction. That closes contention path 3 without touching the backup
pipeline after the snapshot step.

**F5. Durability is backup plus WAL frames, not a live replica.** Phase one keeps today's story: the
object-store backup per tenant is the recovery unit, so losing a node means restoring its tenants onto another
node from `latest.json`, with RPO equal to the backup interval. Phase two ships WAL frames to the object store
after each checkpoint window (the Litestream/Turso shape), which cuts RPO to seconds and makes a tenant move a
"ship the last frames, flip the placement epoch" operation instead of a full copy. Read replicas are
deliberately out: reads are already in-process at 4 ms p50 on the owner, and a replica would add a second
file, a second set of descriptors and a staleness contract for a workload that has not asked for it.

**F6. Moving a tenant is a four-step epoch dance, not a rebalance.** `frozen` in placement (writes get a typed
retryable error for the move window, reads continue on the old owner), snapshot plus last WAL frames to the
object store, restore on the new owner, flip `node_id` and bump `epoch`, `active`. The forwarder's
`WrongOwner` retry makes in-flight requests self-heal. This is the only operation that needs the control plane
to be more than a lookup table, and it is an admin CLI command, not a daemon, in phase one.

### 1.5 What I would build first, and why

**F3 then F4 on a single node**, before any second node exists. Reasons:

- They close contention paths 1, 2 and 3, which are the ones that violate constraints 2 and 3 _today_, with
  one node. Placement (F1, F2) only addresses constraint 1 and adds nothing to isolation if the node behind it
  still blocks on one loop.
- They are testable with the existing harness: the sq-06 style "50 writes across 5 tenants" stress and a new
  "one tenant runs a 2 s query, another tenant's once-a-minute write lands within 50 ms" test are both
  single-process tests.
- They carry the risk. Workers mean message-passing for every request and a second place where handles are
  owned and closed, so the shutdown ordering that `platform/layers.ts` enforces must extend into the lanes.
  Better to find that out before the network is involved.

Then F1 and F2, which are mostly the `ControlPlaneRouter` that MT-04 already sketched plus a forwarder, and
last F5 phase two and F6, which are operational features.

### 1.6 Known risks of F

- **Worker transport cost.** Every mutation crosses a structured-clone boundary twice. On a 4 ms p50 that is a
  visible tax; the mitigation is to send compiled SQL and bind values, not plans, and to measure before
  deciding whether lanes are workers or child processes. Child processes isolate crashes too (the reader child
  already proves the supervision pattern) at the cost of a heavier IPC.
- **Lane skew.** Sticky hashing can put two hot tenants on one lane. Placement knows per-tenant load from the
  event log; a node-local re-lane on restart is cheap, and a cross-node move is F6.
- **Stale placement during a move.** Covered by epochs and the single retry; a test must prove a request that
  arrives mid-move either completes on the new owner or fails with a retryable error, never writes to the old
  file after the flip.
- **It does not give multi-node reads of one tenant.** By design. If a single tenant ever outgrows one node's
  read capacity, that is the moment to add a replica for that tenant, not a mesh for everyone.

---

## Part 2 — Review of the other sets and the final ranking

_Written after Part 1 was committed._
