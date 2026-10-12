# Review of the Opus and Astra scale-out designs (Fable)

Status: review · Reviewer: Fable 5.1 · Date: 2026-10-12 · Branch: `arch/fable-ranking` · Code checked against
`main` at `e808983`.

Companion to [scale-out-fable.md](scale-out-fable.md), which ranks the approaches. This document is the review
itself: what each design gets right, numbered findings with severity and the evidence behind each, and a
verdict per set. Severity: **major** means the finding changes whether the design meets a stated constraint or
whether the document can be used as a build basis; **minor** means it needs a correction but no redesign;
**nit** is presentation.

## Scope and method

| Set           | Branch / commit                                | Fork point from `main`                      | Approaches | Author's pick |
| ------------- | ---------------------------------------------- | ------------------------------------------- | ---------- | ------------- |
| Opus original | `arch/opus-scale-out` `ad0864d` (2026-10-11)   | `cd669d1`, before SP-02 landed (`35ca862`)  | A, B, C, D | A             |
| Opus revised  | `arch/opus-scale-out-2` `165fd9c` (2026-10-11) | same file plus "Research-informed revision" | adds E     | E             |
| Astra         | `arch/astra-scale-out` `9f835dc` (2026-10-11)  | `cd669d1`; text states baseline `1031b06`   | 1, 2, 3, 4 | 3             |

Both sets were written the day the in-process SQLite document-read pivot (SP-02) landed, from a fork point
just before it. At that fork, document reads still crossed IPC to the DuckDB child. Astra says so and assumes
the pivot; Opus does not state a baseline. Findings below are judged against the landed code, with that timing
noted where it excuses a statement.

Each claim about the current system was checked by reading `platform/sqlite.ts`,
`platform/document_reader.ts`, `platform/layers.ts`, `platform/server.ts`, `platform/backup.ts` and
`platform/tenants/routing.ts` on `e808983`. Two claims about the runtime were tested on this VM (scratch
scripts, Deno 2.9.5, `deno run -A`): descriptors per connection (3 writer, 2 reader) and whether
`worker.terminate()` interrupts a blocked `node:sqlite` call (it does not; the process waited 24.9 s for the
statement to finish).

---

## Opus (A–D, then E)

### What it gets right

- **The shape of A.** Explicit tenant-to-node placement in a Postgres-backed control plane, growing out of the
  registry MT-03 landed and the `TenantStorageRouter` seam MT-04 reserved for `"control-plane"`. This is the
  correct cross-node skeleton and matches the repo's own plan.
- **The argument against hashing.** "Keep the routing decision explicit and auditable for as long as you can"
  is the right principle for data with gravity, and the revision's quantified demotion of D (distributed
  writes only past thousands of mutations per second, against one per minute here) is a good use of the
  research.
- **Durability as a stream.** The revision's one lasting contribution is "make durability continuous (WAL
  streaming), not periodic (snapshots)". That belongs in any long-term plan.
- **Readable.** Each approach has a diagram, a relationship table, a constraint-by-constraint section, a "what
  breaks" section and a "pick when". The structure makes the comparison easy to audit.

### Findings

**O1 (major). The in-node isolation claim is false for the landed code, and the document never considers the
mechanism that falsifies it.** A says "shard boundaries are isolation boundaries" and cold tenants "contend
only within their shard"; D says "pool separation + per-file queues" means "a hot read cannot block the hot
write". `node:sqlite` is synchronous and every statement runs on the process's single event loop
(`platform/sqlite.ts`, `platform/document_reader.ts`). A 200 ms statement for any tenant on a node stalls
every other tenant on that node for 200 ms, whatever queue or pool it came through. The words "event loop" and
"synchronous" do not appear anywhere in either Opus version (grep count 0 for both). Constraint 3 is therefore
not met by A, C, D or E as written; each needs an in-node bulkhead (killable child processes) that the
document does not have. Astra's approach 1 supplies exactly this, which is why the ranking puts a
less-polished Astra design above A.

**O2 (major). Approach B proposes what MT-04 already landed, and misreads what the landed cache does to the
hot write.** `platform/sqlite.ts:641-760` is a leased LRU of tenant storage instances with capacity 64 and 60
s idle expiry, eviction only of unleased entries, single-flight open. B's "DescriptorBroker" restates it. The
one new element, a pin API, is not there, and the landed cache interacts badly with the brief's hot write: a
tenant that writes exactly once a minute is idle for 60 s between writes, which is the idle threshold, so it
is a candidate for eviction right before every write and may pay a cold open each time. B does not notice this
because it does not read the landed code; the document says as much ("Not audited against landed code"). A
stopgap that is already built, and that already has the failure mode the brief cares about, cannot be ranked
as a stopgap.

**O3 (major, E only). E's cost is understated and its main mechanism conflicts with the repo's central
architectural rule.** E requires "a libSQL-style frame log or equivalent". The platform runs stock SQLite via
`node:sqlite`; libSQL in Deno means a third native library in a codebase whose load-bearing constraint (plan
§0, ADR 0004) is keeping two native SQLite copies out of one address space. The alternative, "a custom
WAL-frame shipper to build", is a new storage component on the hottest path. E also "replaces the
snapshot→object-store backup flow", a pipeline that SP-06 just verified end to end. All of this buys node-loss
survival and hot-read fan-out, which none of the three constraints asks for. The revision's own "what breaks"
paragraph lists these costs and then picks E anyway on the grounds that "deferring them saves little". It
saves the whole of them until a constraint requires them.

**O4 (minor, qualified by the sources audit). C's replication story is under-specified.** "Litestream-style
WAL shipping" is named as the mechanism for live read replicas. Until October 2025 Litestream was a backup and
restore tool only. Litestream 0.5.x adds a VFS read replica: read-only by default, pages fetched on demand
from object storage, polling every second, documented as "not high-concurrency OLTP", labelled experimental,
with an open wedging bug. So C's replicas are feasible, about a second stale, and not a hot-path read tier.
The revision replaces this with libSQL frame-log replication, which inherits O3 and is Turso's legacy path
(see [scale-out-sources-fable.md](scale-out-sources-fable.md), claims 5 and 11). Failover and promotion are
acknowledged as unsolved in both versions.

**O5 (minor). The revision's research source is an untracked temp file.** The revision cites
`/tmp/convex-surreal-research.md (vm-1)`. It exists today (8.5 KB, 2026-10-11 22:47) and will not survive a
reboot or a different host. Astra's revision cites primary URLs instead. A design document should not depend
on a path under `/tmp`.

**O6 (minor). No fencing, no idempotency.** A describes placement moves as "cache invalidation during
rebalancing is the classic hard part" and stops. It does not say how an old owner is prevented from writing
after a move, nor what a client does when a forwarded mutation times out with unknown outcome. Astra 2 covers
both (epoch compare-and-swap, durable fencing before cutover, request IDs); any build of A needs them.

**O7 (minor). The gateway fleet is a new deployment unit without a reason.** Auth, rate limiting and the
tenant lookup already live in the server (`platform/http/auth.ts`, MT-07). A separate stateless gateway tier
adds a hop and a second process type; the same routing can run in every node's HTTP layer with forwarding to
the owner.

**O8 (nit). Diagrams do not follow the repo's C4 contract.** `docs/architecture/AGENTS.md` requires every
diagram in two formats, generated from `diagrams/*.py`, with type labels on every element. The Opus diagrams
are hand-written Mermaid only. Acceptable in a proposal, but the document does not say so.

**O9 (minor, from the sources audit). The "~5k mutations/sec" trigger is unsourced.** The revision demotes D
with "Convex is explicit: partitioned/distributed writes only become necessary past ~5k mutations/sec
sustained". Neither Convex article the brief draws on ("How Convex Works", "How We Horizontally Scaled
Function Execution") contains that figure or any mutations-per-second threshold; the number appears only in
the untracked research brief. The demotion of D stands on its qualitative grounds; the quantitative claim
should be removed or attributed.

**O10 (nit, from the sources audit). "TAPIR/Litestream lineage" misattributes a term.** TAPIR is the name
SurrealDB's CEO uses for SurrealDB's object-storage-backed node design (trade press, July 2026). It has no
connection to Turso's bottomless WAL, which the revision pairs it with.

### Verdict: FAIL as a build basis; A's skeleton is reusable

The document is well organised and its cross-node instinct is right, but it would send a builder to implement
a design whose constraint-3 claim does not hold on the landed runtime (O1), with a stopgap that already exists
(O2), and, in the revised pick, with a replication layer whose cost and architectural conflict are
acknowledged and then waved through (O3). Reuse: A's placement map and the "explicit over hashed" principle;
the revision's WAL-streaming idea as a later phase.

---

## Astra (1–4)

### What it gets right

- **The baseline.** The opening section reads the landed code and corrects the brief: tenant mode already has
  a leased 64-entry cache with per-instance writer semaphores, and the real shared paths are "one server event
  loop and cache coordination path". Both statements are confirmed. The cache lock in
  `platform/sqlite.ts:672-760` is held across `router.resolve`, `router.prepare` (which takes
  `BEGIN IMMEDIATE` on a fresh connection, with a 5 s `busy_timeout`) and the pragmas plus schema transaction
  of `makeSingleStorage`, and across `Scope.close` on eviction. One slow cold open blocks every tenant's
  acquire. This is a genuine finding neither Opus version has.
- **Why fibers and semaphores cannot isolate.** "An isolated process is needed because `DatabaseSync` calls
  execute synchronously; adding Effect fibers or per-tenant semaphores cannot preempt them." Confirmed, and
  extended by this review: a Web Worker cannot be terminated mid-statement either, so the process is the right
  unit.
- **Measure the descriptor cost.** Insisting that `d` (descriptors per connection) be measured rather than
  assumed to be one was correct; it is 3 for a writer and 2 for a reader.
- **Fencing and idempotency are first-class.** Approach 2's compare-and-swap epoch, "a metadata epoch alone
  cannot fence a live old SQLite writer", durable fencing before cutover, and request IDs with stored results
  are the parts every other design is missing.
- **Honest guarantee framing.** "Starvation freedom is not unconditional availability" and the explicit fault
  envelope are how a constraint like "never starved" should be read.
- **Acceptance experiments with fixed thresholds.** The five experiments at the end are the only concrete
  validation plan in either set.

### Findings

**A1 (major). The pick solves a constraint the brief does not state.** Approach 3 is chosen because it is "the
only synchronous alternative here that addresses all three constraints while tolerating one data-node
failure". The brief's constraint 2 says the write path must never be starved; it says nothing about node loss.
Astra introduces "within 30 seconds during a supported single-node failure" as "a proposed acceptance target",
labels it as such, and then lets it decide the ranking. Under the constraints as written, approach 2 (with
approach 1 inside each node) meets all three; approach 3 adds three failure domains, quorum commit latency on
every write, and a replication integration that the document itself calls "an unresolved dependency, not an
existing repository feature". The reference research the brief supplies reaches the same conclusion ("quorum
consensus is overkill for us"). The document is internally consistent; the premise is the problem.

**A2 (major). The replication prerequisite has no candidate.** Approach 3 requires "a replication service with
specified, tested SQLite commit/consensus integration" and says plain `node:sqlite` plus Postgres leases does
not supply it. The known candidates each fail a repo constraint: rqlite and dqlite are separate servers with
their own SQLite, so they replace the storage layer rather than wrap it; LiteFS is a FUSE layer with
lease-based single-writer semantics, not consensus; libSQL's frame log is primary/replica, not quorum, and
brings the native-library conflict in O3. Naming this gap would have been enough; picking the design that
depends on it is not.

**A3 (minor). "FD capacity is node-wide; more processes do not fix a host-wide descriptor ceiling" conflates
two limits.** On Linux the limit that bites first is `RLIMIT_NOFILE`, which is per process (1,048,576 here);
the host-wide `fs.file-max` is effectively unbounded on this VM. Child processes do multiply the per-process
budget. The brief's hypothetical ("a node can hold N files") is still a fair design input, and Astra's "both
per node and per process" formula covers both, but the sentence as written would lead a reader to dismiss
process lanes as a descriptor remedy when they are one.

**A4 (minor). The backup stall is gestured at, not named.** Approach 1 says "checkpoint and backup scheduling
runs under an I/O budget, never a global writer mutex". The landed stall is not global: it is
`Storage.snapshot` running `VACUUM INTO` on the per-file writer `Semaphore(1)` (`platform/sqlite.ts:616`,
`platform/backup.ts:10`), so a backup of one tenant's file blocks that tenant's writes for the snapshot's
duration. For a hot tenant with a large file this is the single biggest write stall today, and the fix
(snapshot from a read-only connection; WAL permits it) is small. The document would be stronger for naming it.

**A5 (minor). Approach 1's "protected writer" pins one known tenant rather than protecting every write.** The
hot tenant gets a dedicated process; ordinary tenants' writes queue behind ordinary reads on pooled workers.
If any tenant can become hot ("reserve an activation slot" is Astra's own hedge), a write-first scheduler in
every lane is the general solution and costs no more. The brief's hot write is "a" hot write, not a named
tenant.

**A6 (minor). Approach 2's placement service is a separate daemon before one is needed.** Placement changes
are rare, operator-initiated events in phase one. A table in Postgres written by the admin path that already
creates tenants (MT-05) and a CLI command for moves (MT-06 pattern) is sufficient; a balancing service can
come when load data from the event log justifies it.

**A7 (nit). Length and density.** The document is 613 lines; every approach is specified to the level of
"retain per-tenant sequence ranges, checksums and restore manifests". That rigour is a strength for the pick
and a cost for the three alternatives, which a reader has to work through to find the comparison table at the
end. A one-screen summary up front would have carried the same decision.

**A8 (nit). Diagrams.** Mermaid only, hand-written, as with Opus; Astra states that terminal versions and
index edits are out of scope, which is the right thing to say.

### Verdict: NITS as a design document; FAIL on the pick

Astra's diagnosis, fencing design and validation plan are the best material in either set and are adopted
wholesale in the ranking's top pick. The verdict on the pick is the one place the document goes wrong: it
answers a stronger brief than the one given (A1) with a dependency it cannot name (A2). Approach 2 built on
approach 1 is what the document's own analysis supports.

---

## Cross-cutting

1. **Neither set measured anything.** Both argue from the API documentation about synchronous execution;
   neither counted descriptors, timed a cross-process hop, or checked whether a worker can be killed. Two of
   those three took under a minute each on this VM and one of them (terminate) changes the design.
2. **Neither set names the backup-on-writer-lock stall** as the concrete, fixable, present-day violation of
   constraint 2 (Astra comes closest, A4). It should be the first item in any build plan.
3. **Both overweight replication relative to the brief.** Opus E and Astra 3 both land on "replicate the hot
   data" as the pick. The brief's constraints are about placement, starvation and isolation; replication
   addresses durability and availability. It is a later phase for both sets' own foundations (A and 2).
4. **Both leave the global read cap alone.** `DOCUMENT_READ_CONCURRENCY_CAP = 32` and the 1000-deep admission
   cap are shared by every tenant on the node. Per-tenant admission is a small change that directly serves
   constraint 3 and appears in neither set as a concrete item (Astra has "per-tenant admission" as a
   principle).
5. **Convergence.** Strip O1–O3 from Opus and A1–A2 from Astra and the two sets describe the same system:
   explicit placement in Postgres, owner-executes, killable lanes inside a node, WAL streaming later. That
   agreement is the strongest evidence that the skeleton is right.
