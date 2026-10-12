# Scale-out: final ranking (Fable)

Status: final · Author: Fable 5.1 (with nickstrad) · Date: 2026-10-12 · Branch: `arch/fable-ranking` · Code
baseline: `main` at `e808983`.

This is the deliverable of the scale-out brief: every approach from the three sets ranked, one paragraph each,
what to build first, and the tweaks to the top pick. It supersedes the provisional order in
[scale-out-fable.md §2.3](scale-out-fable.md). The reasoning behind it is in three supporting documents: the
independent pass and provisional ranking ([scale-out-fable.md](scale-out-fable.md)), the review of the Opus
and Astra sets ([scale-out-review-fable.md](scale-out-review-fable.md)), and the audit of external sources
([scale-out-sources-fable.md](scale-out-sources-fable.md)).

## The problem and the yardstick

One server process holds every SQLite handle and funnels work through shared paths. The brief fixes three
constraints: (1) more files than one node can hold, (2) a hot write every minute that must never starve, (3)
no single statement may block everyone. On the landed code the shared paths are: one synchronous event loop
for all `node:sqlite` calls; one 32-permit read semaphore and one 1000-deep admission cap for all tenants;
backups (`VACUUM INTO`) on each file's writer lock; one node's disk as the ceiling for the working set.

Ranking criteria, applied in order: does the approach meet the three constraints as written on the landed
runtime; how much must be built beyond the seams the repo already has (Postgres tenant registry,
`TenantStorageRouter`, supervised child processes, object-store backups); and how much of the design solves a
problem the brief does not pose. Facts that settled close calls were measured on this VM or checked against
primary sources: `node:sqlite` has no statement interrupt, a worker cannot be terminated mid-statement (24.9 s
observed), a WAL writer connection costs 3 descriptors and a reader 2, and `VACUUM INTO` runs from a read-only
connection.

## Ranking

| Rank | Approach                                            | Set   | C1 files > node       | C2 hot write never starved                  | C3 no statement blocks all    | Beyond existing seams                          |
| ---: | --------------------------------------------------- | ----- | --------------------- | ------------------------------------------- | ----------------------------- | ---------------------------------------------- |
|    1 | **F: placement-routed tenant cells, process lanes** | Fable | placement table       | write-first lanes; snapshot off writer lock | killable child-process lanes  | placement table, forwarder, lane supervisor    |
|    2 | 2: capacity-aware tenant shards                     | Astra | placement, CAS epoch  | reserved owner capacity                     | by reference to approach 1    | placement service, remote-execution RPC        |
|    3 | 1: one host, bounded descriptors, isolated lanes    | Astra | LRU only              | protected writer process                    | processes plus supervisor     | lane supervisor, admission router              |
|    4 | A: control/data plane split, explicit placement     | Opus  | shard map             | dedicated node for the hot tenant           | **not met** within a node     | gateway tier, shard map                        |
|    5 | 3: replicated shards, consensus, read replicas      | Astra | placement per voter   | quorum path, reserved capacity              | processes; separate read tier | consensus replication layer (no candidate)     |
|    6 | E: WAL-native control/data plane (A + C)            | Opus  | shard map             | dedicated primary                           | **not met** within a node     | libSQL or custom frame shipper, backup rewrite |
|    7 | C: hot-file primary/replica, sharded cold files     | Opus  | shard map             | dedicated primary                           | **not met** within a node     | async replicas (Litestream VFS), failover      |
|    8 | B: single-node LRU handle cache                     | Opus  | LRU only              | pinned handle, shared loop                  | **not met**                   | nothing; largely landed in MT-04               |
|    9 | D: consistent-hash mesh                             | Opus  | ring                  | semaphore pools                             | **not met** within a node     | gossip membership, online migration            |
|   10 | 4: durable command log, SQLite as projection        | Astra | intake opens no files | durable acceptance, not completion          | per-tenant cursors            | replicated log, new API contract               |

**One change from the provisional order.** Astra 3 and Opus E swap (5 and 6). Applying the first criterion
uniformly, Astra 3 meets constraint 3 and E does not, and the sources audit removed E's claimed advantage: the
frame-log replication it calls production-proven is Turso's legacy path since the 2024 rewrite. Both remain
heavy answers to a constraint the brief does not state; of the two, the one that is complete and meets all
three constraints ranks higher.

### 1. F, Fable (new; assembled from existing seams)

Cross-node: a `placement` table beside the tenant row in Postgres maps tenant to owner node with a lease and
an epoch; any node authenticates and either executes locally or forwards to the owner with the resolved tenant
id and a request id, so the client contract is unchanged. In-node: the main thread serves HTTP only; tenants
are sharded across supervised child-process lanes (the reader-child pattern already in the repo), each with
its own handle LRU, read pool, per-tenant admission cap and a scheduler that runs a file's mutation ahead of
any read; `Storage.snapshot` moves to a read-only connection so backups never hold the writer lock. It is the
only design in the three sets that closes all four landed shared paths and all three constraints without a
consensus system, a new storage engine or an API change. Its one open cost is the IPC tax of process lanes on
a 4 ms p50 path, which is a measurement with a threshold, not a design unknown.

### 2. Astra 2: capacity-aware tenant shards

The best cross-node design of the nine others: compare-and-swap ownership epochs, "a metadata epoch alone
cannot fence a live old SQLite writer", durable fencing before cutover, request ids with stored results, and a
remote-execution API that never serializes a path. Every one of those is adopted in F. It ranks second because
it leaves in-node isolation to approach 1 by reference, keeps the global read cap and the
backup-on-writer-lock stall, and proposes a placement daemon before placement changes are frequent enough to
need one.

### 3. Astra 1: one host, bounded descriptors, isolated lanes

The correct single-node step and the clearest statement in either set of why fibers and semaphores cannot
isolate a synchronous driver; the measurements here confirm it and extend it to workers. It satisfies
constraints 2 and 3 on one host with killable processes, a protected writer and per-tenant admission. It ranks
third because alone it meets constraint 1 only in the literal LRU sense, and because it protects one named hot
tenant rather than making every tenant's write first in its lane.

### 4. Opus A: control/data plane split with explicit placement

The right shape on the right seams, and the right principle: keep placement explicit and auditable rather than
hashed. It ranks fourth, above two designs that meet more constraints, because what it lacks is one bounded
addition (killable lanes inside each node) after which it converges on F, whereas the designs below it add
machinery that is not needed. As written it does not meet constraint 3: "shard boundaries are isolation
boundaries" is false on a single synchronous event loop, and the document never considers that loop.

### 5. Astra 3: replicated shards with consensus and read replicas

The most rigorous design and the strongest guarantee: writes acknowledged after quorum, fenced authority,
barrier reads, and a validation plan with fixed thresholds. It meets all three constraints. It ranks fifth
because it is built for a fourth constraint the brief does not state (surviving node loss within a deadline),
it names its replication layer as "an unresolved dependency" and no candidate fits the repo (rqlite and dqlite
replace the storage layer, LiteFS is lease-based not consensus, libSQL is primary/replica and a third native
library), and the reference research judges quorum consensus overkill here. If the product ever adopts a
node-loss SLO, this is the design to return to.

### 6. Opus E: WAL-native control/data plane

A plus C's replication from day one, citing Turso. The durable idea, continuous WAL streaming instead of
periodic snapshots, is adopted in F as phase two. As a pick it inherits A's unmet constraint 3 and front-loads
the heaviest work in any set: a libSQL migration (a third native SQLite copy in a repo whose central rule is
keeping native SQLite copies apart) or a hand-built frame shipper, a rewrite of the verified backup pipeline,
and undesigned failover. The sources audit found the mechanism it calls production-proven is Turso's legacy
path, and the Convex throughput figure used in the same revision is unsourced.

### 7. Opus C: hot-file primary/replica plus sharded cold files

Solves a hot _read_ problem the system does not have: reads are in-process at 4 ms p50 on the owner. The
sources audit makes its mechanism feasible (Litestream 0.5 ships an experimental VFS read replica, read-only,
about a second stale, not for high-concurrency reads), so it is under-specified rather than hand-waved, but it
still triples storage for the hot file, adds stale reads and failover design, and does not meet constraint 3.
The revision folded it into E.

### 8. Opus B: single-node LRU handle cache

Largely landed already: MT-04 shipped a 64-entry leased LRU with 60 s idle expiry. It did not stop the
contention the brief describes, which is the evidence that descriptors were never the binding constraint. The
one new element, pinning, is absent from the landed cache, and the landed cache has a failure mode B does not
see: a tenant that writes once a minute idles for exactly the eviction threshold and may pay a cold open under
the cache-wide lock before every write. Ranked above D and 4 only because it is harmless.

### 9. Opus D: consistent-hash mesh

Fights data gravity (a ring change moves files, not slots), removes operator override, cannot give a hot
tenant its own node, needs gossip membership and online migration, and still does nothing about in-node
blocking. Opus's own revision demoted it; the quantitative trigger it cites is unsourced, but the demotion
holds on the qualitative argument and on a hot path of one write per minute.

### 10. Astra 4: durable command log, SQLite as projection

Internally coherent and honest about its cost, but it changes what the brief holds fixed: mutations become
`202 Accepted` with a receipt, and conditional state transitions can no longer return their result
synchronously. Astra says it should not be quietly imposed on this API. It is a different product.

## What to build first

**The in-node half of F, on one node, before any placement work.** Concretely: child-process lanes with sticky
tenant assignment and a supervisor that kills a lane past its deadline; a write-first scheduler per lane;
per-tenant admission caps replacing the global 32-permit and 1000-deep caps; `Storage.snapshot` on a read-only
connection. This is also the overlap of F, Astra 1 and Astra 2, so it is the step every credible design agrees
on.

Why first: it fixes the contention that violates constraints 2 and 3 _today_, on the hardware the platform
already runs on, with the single-process test harness. Two acceptance tests define done, and both fail on
`main` now: (a) one tenant runs a 2 s statement while another tenant's once-a-minute mutation commits within
50 ms; (b) a backup of a 1 GB file runs while that file's mutations keep committing. Placement (F1, F2) is
pure routing on top of a node that is already safe; building it first would route requests to nodes that still
block on one loop.

Gate for the step: getGame p50 through a child-process lane against the in-process 4.1 ms baseline, on a quiet
host with load average recorded. More than about 2 ms added at p50 reopens the worker variant for reads only,
with writes kept in killable processes.

## Tweaks to the top pick

1. **Lanes are child processes, not workers.** Workers keep the main loop live but cannot be terminated
   mid-statement; only a process can be killed. Reuse the supervised-child pattern and JSON-lines framing from
   the reader; resolve a killed lane's in-flight mutations by request-id lookup, never by blind replay.
2. **Lease-fenced ownership.** A node serves a tenant only under an unexpired heartbeat lease by its own
   clock; a move flips the epoch only after the old lease has expired or the old owner has acknowledged the
   freeze.
3. **Request ids on every forwarded mutation**, stored in the tenant file with the result inside the writer
   transaction, so a timed-out forward is a lookup on retry.
4. **Hot-tenant lane pinning.** Placement may pin a tenant to a dedicated lane on its node, so its write bound
   is its own duration rather than "longest statement on the lane plus own duration". Opus A's dedicated node
   and Astra 1's protected writer, at lane granularity, with no new node.
5. **A measured descriptor formula in config.** Node capacity from `nofile`, a reserve, and 3 descriptors per
   writer plus 2 per pooled reader, not one per file.
6. **WAL frames to the object store as phase two**, after each checkpoint window, supplementing the snapshot
   path rather than replacing it. Taken from Opus E and the Turso research; recovery point drops from the
   backup interval to seconds and a tenant move becomes "ship the tail, flip the epoch".
7. **No read replicas until a single tenant outgrows one node's read capacity.** Astra 3 and Opus C/E are the
   designs to reopen then, for that tenant only.
