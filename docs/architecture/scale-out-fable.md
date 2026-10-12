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

Written after Part 1 was committed as `c423e4e`. Sources reviewed: `arch/opus-scale-out`
(`docs/architecture/scale-out-opus.md`, approaches A–D, pick A), `arch/opus-scale-out-2` (same file plus the
"Research-informed revision", adds E, new pick E), `arch/astra-scale-out`
(`docs/architecture/scale-out-astra.md`, approaches 1–4, pick 3), and the brief's research notes on Turso,
Convex and SurrealDB.

### 2.1 What the review changed in my own proposal

Two corrections, both from measurements made after reading Astra's argument that "an isolated process is
needed because `DatabaseSync` calls execute synchronously":

1. **Worker lanes cannot enforce deadlines.** On this VM, `worker.terminate()` against a worker blocked in a
   40-million-row recursive SQLite query returned in 0 ms, but the process could not exit for 24.9 s: the
   native call ran to completion. A worker lane keeps the main loop live (Part 1's 1.9 s test still holds) but
   a stuck statement in a lane holds that lane, and every tenant on it, until SQLite returns. Strict isolation
   therefore needs lanes that can be killed, which means child processes. The repo already has the
   supervised-child pattern (`platform/ipc.ts`, the reader restart in `platform/layers.ts`), so this is less
   new code than workers would have been, at the cost of JSON-lines IPC instead of structured clone. F3 below
   is revised to "child-process lanes, with the worker variant as a measured fallback only if IPC cost on the
   4 ms p50 path is unacceptable".
2. **Epochs alone do not fence an old owner.** Astra is right that a Postgres epoch cannot stop a partitioned
   node from writing to its local file. F6 gains a node lease: a node serves writes for a tenant only while
   its heartbeat lease is unexpired by its own clock, and a move flips ownership only after the old lease has
   expired or the old owner has acknowledged the freeze. The restore-from-object-store move stays the same.

Astra's request-ID idempotency for forwarded mutations is adopted too: a forward that times out has an unknown
outcome, and the retry must look up the result rather than re-run the handler.

### 2.2 Observations on the other sets

**Opus A–D (original).** The document says it is "not audited against landed code", and that shows in two
places that matter for this brief. Approach B, the LRU handle cache with pinning, is largely already on
`main`: MT-04 landed a 64-entry leased LRU with idle expiry in `platform/sqlite.ts`. Proposing it as a stopgap
is proposing the status quo. More seriously, Approach A claims "shard boundaries are isolation boundaries" and
that cold tenants "contend only within their shard". With a synchronous driver on one event loop, every tenant
on a node contends with every other tenant on that node, regardless of shard map or semaphores. A, C and D all
describe pools and queues as if they could preempt a running statement; none of them can. A's shape is right
and matches the repo's seams; its isolation claim within a node is not.

**Opus E (revision).** E keeps A's shape and adds C's replication from day one, citing Turso's frame-log and
bottomless WAL. Everything true of A's in-node blind spot is true of E. The additions solve node loss and hot
read fan-out, which the brief's three constraints do not ask for, and they are the most expensive items in any
set: frame-log replication means either a libSQL migration (a third native library next to `node:sqlite` and
DuckDB, in a repo whose central architectural rule is about keeping native libraries apart) or a hand-built
WAL frame shipper, plus a rewrite of the verified backup pipeline. The one piece worth taking now is "make
durability continuous, not periodic": WAL-to-object-store is the right phase-two upgrade for backups. As a
first pick, E front-loads the least-constrained, highest-risk work.

**Astra 1–4.** The baseline section is the best diagnosis in the three sets: it reads the landed cache, names
the single event loop and the shared cache lock as the real shared paths, and insists the descriptor cost per
connection be measured (Part 1 measured it: 3 for a writer, 2 for a reader). Approach 1 is the right in-node
design and is close to F3/F4. Approach 2 is the right cross-node design and is close to F1/F2 with stronger
fencing. Approach 3, the pick, adds three-voter consensus per shard and a separate read deployment. Astra
justifies it by reading constraint 2 as "the write must survive one data-node failure within 30 seconds", a
target Astra adds itself and labels as such. The brief does not ask for node-loss survival, the reference
research says quorum consensus is overkill for this system, and Astra's own text names the replication
integration as "an unresolved dependency, not an existing repository feature". Approach 4 changes the API
contract to asynchronous acceptance; Astra correctly calls it "a deliberate product fork".

### 2.3 Final ranking

| Rank | Approach                                                 | Set   | Constraint 1: files > one node | Constraint 2: hot write never starved       | Constraint 3: no single statement blocks everyone | Status                             |
| ---: | -------------------------------------------------------- | ----- | ------------------------------ | ------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
|    1 | **F — placement-routed tenant cells with process lanes** | Fable | Placement in Postgres          | Write-first lane scheduler; backup off lock | Child-process lanes, per-tenant admission         | New, assembled from existing seams |
|    2 | 2 — capacity-aware tenant shards                         | Astra | Placement with CAS epochs      | Reserved owner capacity                     | Defers to approach 1's processes                  | Proposal                           |
|    3 | 1 — one host, bounded descriptors, isolated lanes        | Astra | LRU only; one node             | Protected writer process                    | Processes plus supervisor                         | Proposal                           |
|    4 | A — control/data plane split, explicit placement         | Opus  | Shard map                      | Dedicated node for the hot tenant           | Not addressed within a node                       | Proposal, unaudited                |
|    5 | E — WAL-native control/data plane (A + C)                | Opus  | Shard map                      | Dedicated primary                           | Not addressed within a node                       | Proposal, needs libSQL or shipper  |
|    6 | 3 — replicated shards with consensus and read replicas   | Astra | Placement on every voter       | Quorum path with reserved capacity          | Processes; separate read deployment               | Proposal, unresolved dependency    |
|    7 | C — hot-file primary/replica plus sharded cold files     | Opus  | Shard map                      | Dedicated primary                           | Not addressed within a node                       | Proposal, unaudited                |
|    8 | B — single-node LRU handle cache                         | Opus  | LRU only; one node             | Pinned handle, shared loop                  | Not addressed                                     | Largely landed (MT-04)             |
|    9 | D — consistent-hash mesh                                 | Opus  | Ring spreads files             | Pool separation (semaphores)                | Not addressed within a node                       | Proposal, unaudited                |
|   10 | 4 — durable command log, SQLite as projection            | Astra | Intake opens no files          | Durable acceptance, not completion          | Per-tenant cursors                                | Proposal, changes the API          |

**1. F (Fable).** It is the only design in the three sets that closes all four contention paths named in §1.1
and satisfies all three constraints as written, without a new consensus system, a new storage engine or an API
change. Cross-node it is Astra 2's placement with its fencing (lease plus epoch) and Opus A's operator-visible
map; in-node it is Astra 1's killable process lanes with two things neither set has: the snapshot moved off
the writer lock, which is today's largest single write stall, and admission caps made per tenant instead of
global. Its weakest point is the IPC tax of process lanes on a 4 ms p50 path, which is a measurement, not a
design unknown. Rank 1 because it does the least that is sufficient.

**2. Astra 2.** The best cross-node design of the nine others: compare-and-swap ownership epochs, fencing
before flip, request IDs, a remote-execution API that never serializes a path, and a refusal to let a hash
ring transfer write authority. It ranks below F only because it leaves in-node isolation to approach 1 by
reference and does not touch the backup-on-writer-lock path or the global read cap. F is, in effect, Astra 2
plus Astra 1 plus those two fixes; if F did not exist, this is what I would build.

**3. Astra 1.** The correct single-node step and the best write-up of why fibers and semaphores cannot isolate
a synchronous driver. It satisfies constraints 2 and 3 on one host with killable workers, a protected writer
process and per-tenant admission. It ranks third because, alone, it answers constraint 1 only in the literal
LRU sense and gives up the moment a second node is needed, and because its "protected writer" pins one known
hot tenant rather than making every tenant's write first in its lane.

**4. Opus A.** The right shape, the right seams (Postgres registry, `TenantStorageRouter`), and the right
instinct that explicit placement beats hashing for data with gravity. It ranks fourth because it is unaudited
and it shows: it treats a node as an isolation boundary when the landed code has one synchronous event loop
per node, so its constraint-3 claim is false until something like Astra 1 or F3 is added inside the node. With
that addition it converges on F.

**5. Opus E.** A, plus Turso-style frame-log replication and bottomless WAL from day one. The durability idea
is good and appears in F as phase two. As a first pick it ranks below A because it inherits A's in-node gap
unchanged and adds the heaviest, least-asked-for work in any set: a libSQL migration or custom frame shipper,
failover design, and a rewrite of a verified backup pipeline, to protect a once-a-minute write that no
constraint says must survive node loss.

**6. Astra 3.** The most rigorous document of the nine and the strongest guarantee: a write acknowledged only
after quorum, fenced authority, barrier reads. It ranks sixth because it is built for a constraint the brief
does not state (node-loss survival within a deadline), it names its own replication layer as an unresolved
prerequisite, and the reference research explicitly judges quorum consensus overkill here. If the product ever
adopts a node-loss SLO, this is the design to return to; it ranks above C because its replication story is
sound where C's is hand-waved.

**7. Opus C.** Hot-file primary with one or two async read replicas, plus sharded cold files. It solves a hot
_read_ problem the system does not have (reads are in-process at 4 ms p50 on the owner), triples storage for
the hot file, introduces stale reads and failover design, and does not address in-node blocking. The revision
folded it into E, which is where its one good idea now lives.

**8. Opus B.** An LRU of at most K handles with the hot file pinned. The repo already has this (64 entries,
leased, idle-expired) and it did not stop the contention the brief describes, which is the best evidence that
descriptors were never the binding constraint. It ranks above D and 4 only because it is harmless and cheap;
as a proposal it contributes nothing new.

**9. Opus D.** A consistent-hash mesh with gossip membership. It fights data gravity (a ring change moves
files, not slots), removes operator override, cannot express "give this tenant its own node", and still does
nothing about in-node blocking. Opus's own revision demoted it with a quantified trigger of thousands of
writes per second; the hot path here is one per minute.

**10. Astra 4.** Durable command intake with SQLite as an asynchronous projection. Internally coherent and
honest about what it changes, but it changes the thing the brief holds fixed: mutations become `202 Accepted`
with a receipt, and conditional state transitions (the tic-tac-toe rules) can no longer return their result
synchronously. Astra says it should not be "quietly imposed" on this API. Agreed; it is a different product.

### 2.4 What I would build first, and why

**The in-node half of F, on one node, before any placement work**: child-process lanes with sticky tenant
assignment, a write-first scheduler per lane, per-tenant admission caps, and `Storage.snapshot` moved to a
read-only connection. This is also the overlap between F, Astra 1 and Astra 2, so it is the step every
credible design agrees on.

Why first: it fixes the contention that violates constraints 2 and 3 _today_, on the hardware the platform
already runs on, and it is testable with the existing single-process harness. Two acceptance tests define
done: (a) one tenant runs a 2 s statement while another tenant's once-a-minute mutation commits within 50 ms;
(b) a backup of a 1 GB file runs while that same file's mutations keep committing. Both fail on `main` today.
Placement (F1, F2) is pure routing on top of a node that is already safe; building it first would route
requests to nodes that still block on one loop.

The measurement that gates the step: getGame p50 through a child-process lane versus the in-process 4.1 ms
baseline, on a quiet host with load average recorded. If the lane adds more than about 2 ms at p50, revisit
the worker variant for reads only, keeping writes in killable processes.

### 2.5 Tweaks to the top pick

1. **Lanes are child processes, not workers** (§2.1). Reuse the supervised-child pattern and JSON-lines
   framing from the reader; a lane that misses a deadline is killed and respawned, and its in-flight mutations
   are resolved by request-ID lookup, never replayed blind.
2. **Lease-fenced ownership** (§2.1). A node serves a tenant only under an unexpired heartbeat lease; moves
   wait for lease expiry or an acknowledged freeze before the epoch flips.
3. **Request IDs on every forwarded mutation**, stored in the tenant file with the result, so a timed-out
   forward is a lookup on retry. Astra's point; it is cheap because the writer transaction already exists.
4. **Hot-tenant lane pinning.** Placement may pin a tenant to a dedicated lane on its node, so its write bound
   is its own duration rather than "longest statement on the lane plus own duration". This is Opus A's
   dedicated node and Astra 1's protected writer, at lane granularity, with no new node.
5. **A measured descriptor formula in config.** Node capacity derives from `nofile`, a reserve, and the
   measured per-connection costs (3 per writer, 2 per pooled reader), not from "one file, one descriptor".
6. **WAL frames to the object store as phase two**, after each checkpoint window, taken from Opus E and the
   Turso research. It cuts recovery point from the backup interval to seconds and makes a tenant move "ship
   the tail, flip the epoch". It does not replace the snapshot path; it supplements it.
7. **No read replicas until a single tenant outgrows one node's read capacity.** Astra 3 and Opus C/E are the
   designs to reopen at that point, for that tenant only.

### 2.6 Evidence recorded for this document

| Measurement (2026-10-12, this VM, Deno 2.9.5, `deno run -A`, scratch scripts)                  | Result                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Descriptors per WAL writer connection / per read-only connection (20 of each, `/proc/self/fd`) | 3 / 2                                        |
| `ulimit -n` on this VM                                                                         | 1,048,576                                    |
| 1.9 s SQLite query inside a Web Worker; main loop 10 ms ticker                                 | 188 ticks (loop stayed live)                 |
| `worker.terminate()` on a worker blocked in a ~25 s SQLite statement                           | returned in 0 ms; process exit waited 24.9 s |

Baseline figures quoted from `docs/architecture/sqlite-document-reads.md` (SP-06): in-process getGame p50
4.103 ms, p99 12.525 ms, on a shared host with no isolation.
