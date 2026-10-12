# Scale-out: audit of external sources (Fable)

Status: sources audit · Author: Fable 5.1 · Date: 2026-10-12 · Branch: `arch/fable-ranking`.

Companion to [scale-out-fable.md](scale-out-fable.md) (ranking) and
[scale-out-review-fable.md](scale-out-review-fable.md) (review). The ranking, the review and both other sets
lean on claims about Turso, Convex, SurrealDB, Litestream, LiteFS, rqlite, dqlite, libSQL, SQLite and Node.
This document checks each claim against a primary source where one exists and says what, if anything, the
result changes. Verdicts: **confirmed**, **qualified** (true with a condition the claim omitted), **dated**
(was true, no longer the current state), **not found** (no primary source supports the figure or statement),
**refuted**.

Searches were run on 2026-10-12. Vendor documentation describes vendors' systems; nothing here transfers a
vendor's latency or durability figure to this platform.

## Claims that affect the ranking

| #  | Claim                                                                                                                                   | Made by                                          | Verdict       | What the sources say                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | `node:sqlite` is synchronous; nothing can interrupt or time out a running statement.                                                    | Astra; Fable                                     | **confirmed** | Node's API reference states "All APIs exposed by this class execute synchronously" for `Database`, `Statement` and `SQLTagStore`. The only time option is `timeout`, the SQLite busy timeout for lock waits (added in Node 22.16 and 24.0); no interrupt, progress handler or statement timeout is documented. Deno's build keeps the `DatabaseSync` name.                                                                                                                               |
| 2  | A `VACUUM INTO` snapshot can run from a read-only connection, so backups need not hold the writer lock.                                 | Fable (tweak F4c)                                | **confirmed** | SQLite's `lang_vacuum` page: "VACUUM (but not VACUUM INTO) is a write operation"; the output "is a consistent snapshot of the original database". An SQLite check-in note records that VACUUM INTO was "enhanced so that it works on read-only databases", and `test/vacuum-into.test` opens the source read-only. Turso's docs add that `query_only` mode blocks it; stock SQLite does not document that.                                                                               |
| 3  | WAL mode: readers do not block the writer and vice versa; long readers block checkpoints; one writer at a time; no network filesystems. | Astra; Fable                                     | **confirmed** | SQLite's WAL page, verbatim on all four points, with the "mostly true" caveats (exclusive locking mode, last-connection cleanup, crash recovery).                                                                                                                                                                                                                                                                                                                                        |
| 4  | Turso acknowledges a commit only after the WAL is persisted to S3 Express; local disk is a cache.                                       | Astra                                            | **confirmed** | Turso's "What is Turso?" page: the WAL "is persisted to S3 Express before the transaction is acknowledged". Turso's durability docs say "S3 or S3-express". Compute nodes are disposable; servers checkpoint about every 1 MB written so the whole WAL is local.                                                                                                                                                                                                                         |
| 5  | Turso's frame-log replication (libsql-server) is "production code, not a sidecar to build".                                             | Opus E                                           | **dated**     | Turso's CEO states the libsql-server components were rewritten in August 2024 to the S3-based diskless architecture above; libsql-server's last tagged release is February 2025 and it is "maintained but no longer where new work goes". Frame-log replication exists, but it is Turso's legacy data path, not what Turso Cloud runs on today.                                                                                                                                          |
| 6  | Turso embedded replicas give read-your-own-writes.                                                                                      | Opus E; Astra 3                                  | **qualified** | Turso's embedded-replica docs confirm the local file is updated after a write succeeds, and that this applies to the initiating replica. The same docs steer new projects to Turso Sync (logical change capture on the new engine); embedded replicas remain supported but are being superseded. Astra's "applies to the initiating replica; others need catch-up" is the accurate reading.                                                                                              |
| 7  | Turso: "10k+ databases per account", "hundreds per node", cross-database WAL batching in one S3 PUT.                                    | Research brief; Opus E                           | **qualified** | Turso Cloud launched with 5,000 databases per account and later removed the active-database limit on paid plans; "10k+" is plausible but not a published figure. The AWS case study confirms batching WAL entries from multiple databases on one node for a few milliseconds before upload. "Hundreds per node" appears in the brief, not in a primary source found.                                                                                                                     |
| 8  | Convex: "partitioned writes only become necessary past ~5k mutations/sec sustained".                                                    | Research brief; Opus revision (used to demote D) | **not found** | Neither "How Convex Works" nor "How We Horizontally Scaled Function Execution" gives a mutations-per-second threshold. The former says "if we want to ever serve more than hundreds of requests per second, we need to parallelize" and describes OCC; neither mentions 5,000. The figure's origin is the untracked research brief.                                                                                                                                                      |
| 9  | Convex: single-writer committer plus a router splitting mutations from queries, primary/replica over a distributed log.                 | Research brief; Opus E                           | **qualified** | The committer as "the sole writer to the transaction log" is confirmed. The shipped scale-out (Funrun) is a read-only multi-tenant function runner using rendezvous hashing; writes still go through the per-deployment backend. No shipped mutation/query router or primary/replica is described. Astra's "a design reference, not a verified deployed contract" is correct.                                                                                                            |
| 10 | SurrealDB: namespace is the tenancy boundary; distributed mode uses quorum consensus; compute/storage separation ("TAPIR").             | Research brief; Opus revision                    | **qualified** | Namespaces as the top tenancy layer: confirmed in SurrealDB docs. Distributed storage via TiKV or FoundationDB (Raft inside the store) in older docs; newer docs say "distributed storage" without naming it. TAPIR: a July 2026 trade-press interview quotes the CEO on TAPIR-based nodes over object storage, capped at 15 write nodes; no SurrealDB technical document found. Opus's "(TAPIR/Litestream lineage)" for Turso's bottomless WAL misattributes SurrealDB's term to Turso. |
| 11 | Litestream is a backup/restore tool and does not serve live read replicas.                                                              | Fable review O4                                  | **qualified** | True before October 2025. Litestream v0.5.0 introduced LTX and a VFS read replica: read-only by default, pages fetched on demand from object storage, polling every 1 s, "targets read-replica workloads with moderate query load, not high-concurrency OLTP", labelled experimental in release notes, with an open wedging bug (#1460). Opus C's "litestream-style" replicas are therefore possible, asynchronous, about one second stale, and experimental.                            |
| 12 | LiteFS is lease-based single-writer, not consensus.                                                                                     | Fable review A2                                  | **confirmed** | Fly's docs: primary chosen by a distributed lease (Consul default, TTL at least 10 s, lock delay for skew); one primary at a time; replicas read-only and forward writes; replication asynchronous, so an acknowledged write can be lost on primary failure; FUSE requires `SYS_ADMIN` and `/dev/fuse`.                                                                                                                                                                                  |
| 13 | rqlite and dqlite replace the storage layer rather than wrap `node:sqlite`.                                                             | Fable review A2                                  | **confirmed** | rqlite: a server replicating SQL statements through Raft, rewriting `RANDOM()` to keep nodes deterministic; dqlite: a C library over C-Raft replicating WAL frames, embeddable only through C interop, no `VACUUM`. Both carry their own SQLite build.                                                                                                                                                                                                                                   |
| 14 | libSQL in Deno means a third native SQLite library in the process.                                                                      | Fable review O3                                  | **confirmed** | `@libsql/client` resolves to its web build under Deno and rejects `file:` URLs; local files need `npm:@libsql/client/node` or `npm:libsql`, both N-API bindings that embed libSQL's own SQLite. Reported to work under `deno run`, with a failure reported under `deno compile`. In-process next to `node:sqlite` this is exactly the two-copies situation ADR 0004 exists to avoid.                                                                                                     |

## Claims that do not affect the ranking

| #  | Claim                                                                 | Made by | Verdict       | Note                                                                                                                                                      |
| -- | --------------------------------------------------------------------- | ------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15 | Turso group tokens authorize across all databases in a group.         | Opus E  | **confirmed** | `turso group tokens create <group>` issues a token for any database in the group, with read-only and expiry options. Orthogonal to the three constraints. |
| 16 | Turso Cloud runs a managed control plane over open-source data nodes. | Brief   | **qualified** | A Platform API manages groups and databases; no primary source describes the internal split. Reasonable inference, not a documented architecture.         |
| 17 | Supabase is acquiring Turso (announced 2026-10-02).                   | none    | context       | Turso states the platform keeps running and Turso Database stays open source. Relevant only to how long libsql-server stays maintained.                   |

## What changes

1. **Review finding O4 is qualified, not withdrawn.** Litestream 0.5.x does serve read replicas through a VFS.
   They are asynchronous, about a second stale, experimental and not for high-concurrency reads, so Opus C's
   replication story is feasible rather than hand-waved, and still unsuitable as the hot path's read tier. The
   review text is amended.
2. **Review gains two Opus findings.** O9: the "~5k mutations/sec" figure that the revision uses to demote D
   is not in Convex's published material; it comes from the untracked research brief. The demotion of D stands
   on the qualitative argument (hashing fights data gravity) and on the brief's one write per minute, not on
   that number. O10: "TAPIR/Litestream lineage" attributes SurrealDB's storage term to Turso's bottomless WAL.
3. **Review finding O3 is strengthened.** The frame-log path E calls production-proven is Turso's legacy path;
   Turso itself moved to S3-Express-gated WAL on diskless nodes in 2024. Astra's note that this "is distinct
   from the brief's libSQL/bottomless model" was correct.
4. **Astra's research cross-checks hold.** Every Astra claim audited here (1, 3, 4, 6, 9) is confirmed or
   matches the qualified reading. Astra's verdict and findings are unchanged.
5. **Fable's own design claims hold.** The two facts the top pick depends on beyond this VM's measurements,
   VACUUM INTO from a read-only connection (2) and the absence of any statement interrupt in `node:sqlite`
   (1), are confirmed by primary sources.
6. **The ranking does not change.** No audited claim moves an approach across a constraint boundary. The D
   paragraph in the ranking now notes that its quantitative trigger is unsourced.

## Sources

SQLite: [VACUUM](https://www.sqlite.org/lang_vacuum.html) · [WAL](https://www.sqlite.org/wal.html) ·
[check-in: VACUUM INTO on read-only databases](https://sqlite.org/src/info/55be6d0a9fa8a64b) ·
[test/vacuum-into.test](https://gitea.com/package/sqlite/src/branch/master/testdata/tcl/vacuum-into.test)

Node: [node:sqlite API reference](https://nodejs.org/api/sqlite.html)

Turso: [What is Turso?](https://turso.tech/what-is-turso) ·
[Durability guarantees](https://docs.turso.tech/cloud/durability) ·
[How Turso built a transactional database using Amazon S3 Express One Zone](https://aws.amazon.com/blogs/storage/how-turso-built-a-transactional-database-using-amazon-s3-express-one-zone/)
·
[How does Turso Cloud keep your data durable and safe?](https://turso.tech/blog/how-does-the-turso-cloud-keep-your-data-durable-and-safe)
· [Embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction) ·
[Pekka Enberg on Turso, Turso Cloud and libSQL](https://x.com/penberg/status/2032373944007688226) ·
[Unlimited active databases](https://turso.tech/blog/turso-now-includes-unlimited-databases-for-everybody) ·
[Group tokens](https://docs.turso.tech/cli/group/tokens/create) ·
[Authorization](https://docs.turso.tech/sdk/authorization) ·
[Turso is joining Supabase](https://turso.tech/blog/turso-is-joining-supabase)

Convex: [How Convex Works](https://stack.convex.dev/how-convex-works) ·
[How We Horizontally Scaled Function Execution](https://stack.convex.dev/horizontally-scaling-functions) ·
[OCC and atomicity](https://docs.convex.dev/database/advanced/occ)

SurrealDB: [Concepts](https://surrealdb.com/docs/introduction/concepts) ·
[Architecture](https://surrealdb.com/docs/introduction/architecture) ·
[Scalability blog](https://surrealdb.com/blog/surrealdb-scalability) ·
[Blocks & Files interview, July 2026](https://www.blocksandfiles.com/data-management/2026/07/07/entering-the-world-of-database-surreality/5267533)

Litestream: [How it works: VFS](https://litestream.io/how-it-works/vfs/) ·
[VFS read replicas guide](https://litestream.io/guides/vfs/) ·
[Releases](https://github.com/benbjohnson/litestream/releases) ·
[v0.5.0 announcement (Simon Willison)](https://simonwillison.net/2025/Oct/3/litestream/) ·
[Issue #1460: VFS wedges on non-contiguous LTX](https://github.com/benbjohnson/litestream/issues/1460)

LiteFS: [Introducing LiteFS](https://fly.io/blog/introducing-litefs.md) ·
[Getting started](https://fly.io/docs/litefs/getting-started/) ·
[Config](https://www.fly.io/docs/litefs/config)

rqlite / dqlite: [rqlite: non-deterministic functions](https://rqlite.io/docs/api/non-deterministic/) ·
[dqlite FAQ](https://canonical.com/dqlite/docs/explanation/faq) ·
[Comparing Litestream, rqlite, dqlite (Gcore, 2022)](https://gcore.com/learning/comparing-litestream-rqlite-dqlite)

libSQL in Deno: [libsql-client-ts README](https://github.com/psarna/libsql-client-ts) ·
[libsql-js README](https://github.com/tursodatabase/libsql-js/blob/main/README.md) ·
[Deno Q&A: file URLs rejected by the web client](https://questions.deno.com/m/1162288335088259164) ·
[Drizzle discussion #3122](https://github.com/drizzle-team/drizzle-orm/discussions/3122)

Research brief (untracked, vm-1): `/tmp/convex-surreal-research.md`, 2026-10-11.
