# Language choice for a database-per-app SQLite platform

Research: 2026-10-12. Baseline: `main` at `e808983`. Branch: `research/astra-lang-switch`. Recommendation, not
an adopted implementation plan. Coding and migration effort are excluded from the ranking; runtime overhead,
operational complexity, correctness and compatibility remain technical costs. One separate SQLite database per
app is a requirement. Removing SQLite is outside this analysis.

## Recommendation

**Use a hybrid: keep the Deno API/application layer and move SQLite execution into a small number of
supervised Go processes, with bounded concurrent execution inside each process.** Rust with `rusqlite` is an
equally capable alternative if deterministic memory management is the stronger requirement. Go is my first
choice for this service because its scheduler, channels and cancellation-aware SQLite bindings fit the
combination of HTTP/RPC, queued work and synchronous database execution directly.

This is a real improvement over synchronous SQLite on the API event loop. It is not a cure for the number of
open files, SQLite's single-writer rule, overloaded disks or native crashes. Preserve process boundaries for
failure containment, then use threads/goroutines to avoid requiring a process for each simultaneous statement.
Keep per-app files; manage their active working set explicitly.

A full Go API plus storage rewrite is technically sound, but does not buy stronger SQLite isolation than the
hybrid. It removes one RPC boundary if everything is co-located, at the cost of putting API availability in
the same failure domain as native storage. If it retains separate storage processes, its storage guarantees
converge with the hybrid. A full Rust rewrite has the same architectural tradeoff. Neither is necessary to
solve the three stated constraints.

Keeping Deno throughout is also viable: supervised child-process lanes isolate synchronous SQLite, and the
protected app can have its own lane. Its advantages are a uniform application runtime and direct execution of
existing TypeScript handlers. Its disadvantages are coarser cancellation by process death, one blocked JS
execution thread per running statement, and duplicated runtime/heap overhead across lanes. Those are technical
tradeoffs even with free implementation effort. I prefer native execution because it can usually cancel an
offending statement without discarding the entire lane.

A custom Deno native binding is another viable route: expose SQLite's missing controls and execute work off
the JS thread, rather than retaining `DatabaseSync`. Deno supports FFI and Node-API integration. Such a
binding still needs connection lifetime synchronization and native crash containment; putting it in the API
process weakens the recommended failure boundary. It could compete inside isolated Deno lanes, but must
demonstrate the same cancellation and resource-accounting gates as the Go service.
[Deno native integration](https://docs.deno.com/runtime/fundamentals/ffi/).

## What is actually wrong today

The baseline has in-process document reads in [document_reader.ts](../../platform/document_reader.ts), using
`DatabaseSync`, a read connection per query and a global 32-permit admission cap. Mutations use
[sqlite.ts](../../platform/sqlite.ts); its tenant writer cache defaults to 64 entries and a 60-second idle
expiry. `snapshot` runs `VACUUM INTO` through the same exclusive queue as mutations.
[backup.ts](../../platform/backup.ts) also performs synchronous verification on the snapshot.

The existing supervised child is the DuckDB reader, not an already-landed SQLite execution service.
Child-process SQLite lanes are the mitigation proposed by the scale-out research. The new language must fix
all synchronous database phases, including open, prepare, stepping, snapshot verification and close; moving
only `SELECT` leaves other ways to stall the API.

| Concern                                                 | Runtime/binding contribution                          | What remains after switching language                                   |
| ------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| One statement stalls the API                            | `DatabaseSync` executes on the calling JS thread      | Admission, CPU and I/O capacity, and lock contention still need control |
| Cannot stop a running statement through the exposed API | Missing interrupt/progress interface in this Deno API | Native interrupt is cooperative; it is not a hard kill                  |
| Many file descriptors                                   | Connection lifetime and pooling amplify file count    | Open per-app files still consume descriptors in Go, Rust, C and Zig     |
| Hot write waits behind a snapshot                       | Shared application queue and synchronous snapshot     | A language port preserving that queue preserves the problem             |
| Worker/native failure affects other work                | Shared process failure domain                         | Threads in every language share this failure domain                     |

Deno documents both `DatabaseSync` and `StatementSync` as synchronous and lists no statement-interrupt or
progress-handler API. Wrapping the call in a Promise or Effect does not move it onto another OS thread.
Workers can keep the parent event loop responsive, but that is a different guarantee from stopping native
work. This is a binding limitation, not evidence that the underlying SQLite engine lacks cancellation.
[Deno SQLite API](https://docs.deno.com/api/node/sqlite/).

Prior VM measurements, **not rerun in this task**, found 3 incremental fds per WAL writer and 2 per read
connection in the measured arrangement; a worker's long statement allowed a parent ticker to run, but
termination did not release the process until approximately 24.9 seconds later. See the committed
[Fable evidence, §2.6](https://github.com/nickstrad/ts-db/blob/c09eb08c37c581cfd61847086f7f0afb73ae1672/docs/architecture/scale-out-fable.md).
These are configuration-specific observations, not universal connection costs or a native-language benchmark.
The [landed SP-06 report](sqlite-document-reads.md) is the existing latency baseline.

## Go: yes, with a bounded execution scheduler

**Goroutines, channels and `errgroup` work well here. They do not constitute a fixed SQLite thread pool by
themselves.** A goroutine entering cgo SQLite occupies an OS thread while the C call executes. Go's runtime
allows other goroutines to continue; the runtime explicitly enters its syscall state around C calls.
`GOMAXPROCS` is not a ceiling on simultaneously executing C SQLite calls. Bound database work separately to
avoid creating excessive threads or saturating every CPU.
[Go cgo runtime source](https://go.dev/src/runtime/cgocall.go).

My proposed execution policy is:

1. Admit requests into bounded per-app queues, with a bounded total backlog and a deadline that starts at
   ingress. Reject overload before opening more files or accumulating unbounded waiting goroutines.
2. Schedule those queues fairly across apps. Reserve execution capacity, an open writer handle and CPU/I/O
   headroom for the app with the required once-per-minute write. A shared FIFO or channel alone does not
   provide this reservation.
3. Serialize mutations per app. Permit a small, separately budgeted number of readers on other connections. A
   transaction owns one connection from begin through commit/rollback; never move its statements
   opportunistically among pool connections.
4. Bound the number of executing SQLite calls globally and per class. Keep maintenance and reads from
   consuming all writer capacity. Idle cached handles need not each own a permanent goroutine or OS thread.
5. Tie cancellation to the selected driver's native interrupt mechanism. Wait for the call and cleanup to
   finish before returning its connection to another request. A deadline that only stops waiting for a result
   does not reclaim database capacity.
6. Let a supervisor terminate and replace a storage process if cancellation fails to make progress. Group a
   bounded set of apps per process; give the protected hot app its own process when necessary.

`errgroup` is useful for lifecycle supervision and propagating errors/cancellation. Its concurrency limit can
block new submissions, so the API admission path must not depend on an already-saturated group's `Go` call. It
is not a priority scheduler, descriptor budget or guarantee that foreign code has stopped.
[errgroup documentation](https://pkg.go.dev/golang.org/x/sync/errgroup).

### Binding choice matters more than the word “Go”

| Binding                   | Technical strengths                                                                                                  | Technical limitations / selection rule                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mattn/go-sqlite3`        | Uses C SQLite; integrates with `database/sql`; current source connects context cancellation to `sqlite3_interrupt`   | cgo toolchain and native-library crash domain; inspect and pin the exact release, including row iteration and cancellation races                                                     |
| `modernc.org/sqlite`      | CGo-free port of C SQLite; fits `database/sql`; removes the cgo deployment dependency                                | Generated engine and runtime dependencies remain part of the trusted implementation; do not assume identical performance, extension support or cancellation behavior without testing |
| `zombiezen.com/go/sqlite` | Direct SQLite-oriented API; explicit `SetInterrupt(ctx.Done())`; useful for a service that owns connection lifetimes | Connection lifecycle and pooling policy are more explicit; interrupt state must be reset correctly before reuse                                                                      |

The first row is source-verified: the execution path calls interrupt and waits for completion, and its source
comments acknowledge a race between native calls. This is stronger control than Deno's exposed API, but not a
guarantee of instantaneous cancellation.
[go-sqlite3 source](https://raw.githubusercontent.com/mattn/go-sqlite3/master/sqlite3.go). The other two rows
follow their own documented APIs: [modernc SQLite](https://pkg.go.dev/modernc.org/sqlite),
[zombiezen SQLite](https://pkg.go.dev/zombiezen.com/go/sqlite).

Start a candidate implementation with C SQLite via `mattn/go-sqlite3`, or a direct binding when connection
control proves awkward through `database/sql`. Compare modernc on the actual query mix before choosing it for
throughput or latency. No new measurements here establish a performance winner between these drivers.

`sql.DB` is a pool, not one connection. Set its open and idle limits explicitly. A one-writer pool for each
app still needs an outer limit on how many app pools exist; otherwise a modest per-pool setting multiplies
across every tenant. Close result sets and transactions deterministically. Pool limits can also deadlock code
that holds one connection and tries to acquire another from the same exhausted pool.
[Go connection management](https://go.dev/doc/database/manage-connections).

Go's costs are GC-related latency variability, runtime/thread overhead and, for the C driver, cgo and native
memory outside ordinary Go heap accounting. These do not invalidate it for minute-spaced writes, but the
service must observe total RSS, OS threads, fd use and queue age, not only Go heap size. Goroutines provide
convenient concurrency; they do not create capacity or make the service real-time.

## Rust, C and Zig

| Language | Execution and bindings                                                           | Advantages for this platform                                                                                    | Disadvantages even if implementation effort is free                                                                                                           | Assessment                                                                                  |
| -------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Rust     | `rusqlite` on bounded dedicated workers; async network front end                 | Ownership helps enforce transaction/connection lifetimes; no tracing GC; explicit cross-thread interrupt handle | Blocking SQLite must stay off async executor threads; C SQLite can still crash the process; safe wrappers do not provide scheduling fairness                  | Close second to Go; strongest choice when predictable memory/lifetime control dominates     |
| C        | SQLite's native API on a fixed pthread worker pool, plus a separate network loop | Full access to interrupts, progress callbacks, backup, VFS and allocator controls; minimal wrapper machinery    | Manual memory and lifetime correctness, pointer/close races, process-wide memory corruption; no intrinsic fd or fairness advantage                            | Good for a narrow native component; weaker default for the complete network-facing platform |
| Zig      | Native threads and C SQLite interop, directly or through a wrapper               | Explicit allocation and cleanup; direct C API access without a managed runtime                                  | Does not provide Rust's ownership guarantees; toolchain/binding evolution adds compatibility risk; async I/O alone does not make SQLite stepping asynchronous | Feasible but no demonstrated advantage over Rust/Go for these constraints                   |

`rusqlite::Connection` is `Send` but not `Sync`; serialize its use or give it one owner at a time. Its
separate `InterruptHandle` is `Send + Sync` and can interrupt a computation on another thread.
[Connection](https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html),
[InterruptHandle](https://docs.rs/rusqlite/latest/rusqlite/struct.InterruptHandle.html).

Tokio's `spawn_blocking` prevents a blocking closure from occupying an async executor thread, but an
already-running closure cannot be aborted through its task handle. Its default blocking-thread ceiling is
large, so bound SQLite execution explicitly. For persistent database workers, dedicated threads make ownership
and capacity easier to reason about.
[Tokio blocking tasks](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html).

SQLx provides an async interface by using a background thread and channels for SQLite connections. That is a
valid implementation of the same separation, not an asynchronous SQLite engine. Account for thread growth as
the connection count grows; validate cancellation rather than assuming that dropping an awaiting future
interrupts its SQL. [SQLx SQLite connection](https://docs.rs/sqlx/latest/sqlx/struct.SqliteConnection.html).

For C and Zig, use a threading-enabled SQLite build with one active operation owner per connection. SQLite's
serialized mode adds mutex protection; it does not turn a connection into a parallel query executor. Do not
asynchronously kill a thread while it holds database or allocator locks.
[SQLite threading modes](https://www.sqlite.org/threadsafe.html). Zig supports C interop, while the examined
`zig-sqlite` wrapper explicitly warns that its API can change and notes a pause in new-feature work. This is
evidence about that wrapper, not a claim that Zig cannot host a production database service.
[Zig documentation](https://ziglang.org/documentation/master/),
[zig-sqlite](https://github.com/vrischmann/zig-sqlite).

## Cancellation and the once-per-minute write

SQLite interrupt may be called from another thread, provided the connection cannot close underneath it. It
acts at the earliest available opportunity, may lose a race to successful completion, and affects work on the
connection rather than an arbitrary request identifier. Interrupted writes in explicit transactions can roll
back the transaction. Keep a request-generation token and exclusive lease on the connection until the
cancelling watcher and SQL operation have both finished; a late cancellation must never hit the next request.
[SQLite interrupt contract](https://www.sqlite.org/c3ref/interrupt.html).

Use a progress callback for a deadline/work budget checked during execution, and a bounded busy handler for
lock waits. The progress callback must not mutate its connection. Busy timeout limits waiting for a lock; it
is not a wall-clock statement timeout. None of these mechanisms promises to interrupt arbitrary extension code
or stalled kernel I/O immediately. [Progress handler](https://www.sqlite.org/c3ref/progress_handler.html),
[busy timeout](https://www.sqlite.org/c3ref/busy_timeout.html).

The hot-write requirement needs more than a worker reserved for writes. If a previous transaction on that same
app owns the writer lock indefinitely, another writer cannot bypass it. WAL permits readers alongside a writer
but still only one writer per database; old read snapshots can impede checkpoint progress. Bound transaction
duration, reader lifetime and maintenance work, and monitor WAL growth.
[SQLite WAL concurrency](https://www.sqlite.org/wal.html).

I interpret “never starved” as a bounded completion delay under an admitted workload on a functioning node,
not a promise through disk failure or arbitrary overload. Pick a write-completion SLO separately from its
once-per-minute arrival rate. Its budget must cover bounded queueing, earlier same-app lock occupancy,
execution and durable commit. CPU reservations without disk headroom cannot guarantee it. If strict cross-app
protection is required, combine process separation with CPU/memory/I/O controls and keep the hot writer
outside any process that can be killed for another app's stuck query.

Cancellation or process death after commit but before reply leaves an ambiguous result. Store a request ID and
result atomically with each mutation, then resolve retries from that record. Killing a process is a
fault-containment tool; it must not become blind mutation replay.

## File descriptors: preserve files, bound residency

Changing language leaves the ordinary SQLite VFS opening database, WAL and shared-memory resources. Some
descriptors are shared or retained differently within a process, so the VM's 3/2 observation is a planning
coefficient for that measured layout, not a portable invariant. Re-measure for each chosen driver, process
topology and read/write arrangement. [SQLite VFS boundary](https://www.sqlite.org/vfs.html).

Use two budgets: each process's `RLIMIT_NOFILE`, and a node-wide operational budget that includes every
storage process, API socket, log, backup and observer. Linux's `RLIMIT_NOFILE` is per process; splitting
processes redistributes that limit but does not eliminate node-wide open-file resources.
[Linux resource limits](https://man7.org/linux/man-pages/man2/getrlimit.2.html).

For preliminary sizing using the prior measured coefficients:

```text
estimated node fds = infrastructure reserve
                   + sum_over_processes(3 * writer_connections + 2 * reader_connections)
                   + backup/restore/replication/transient allowance
```

Illustration only: a budget of 4,096 with 1,024 reserved leaves 3,072. At one writer plus two readers per
resident app, the estimate is 7 fds/app, or at most 438 resident apps before adding any unbudgeted resources.
This is arithmetic, not a measured capacity claim. Idle apps can retain their files on disk without retaining
open connections. The number of registered apps need not equal the number resident.

The design should reserve fd tokens before opening handles, account for in-flight opens and closes, pin the
protected writer, evict only idle/unleased entries, and refuse excess work when no safe eviction is possible.
Closing the last handle can itself perform database work; do it off the admission lock and retain its budget
until resources are actually released. Size page caches and prepared-statement caches alongside fd limits.
More processes and more read connections can increase both memory and descriptor use.

The existing leased writer cache is a useful starting point, but its code opens and removes entries under one
cache semaphore. A native redesign should use per-app open coordination and publish the entry after I/O,
avoiding a slow open/close for one app holding the global cache lock. Add reader and background work to the
same resource accounting. An LRU is insufficient if every entry is leased indefinitely.

Do not share a raw OS fd among arbitrary SQLite connections, close descriptors behind SQLite, or use `ATTACH`
as a descriptor-elimination trick. To change physical file opening, change the VFS deliberately and preserve
its locking and durability contract. Distributed placement is the next step when the active working set
exceeds one node's budget, not when the count of cold files happens to grow.

## What other SQLite platforms actually solve

The sources below document storage and concurrency architecture. **They do not publish a common per-node fd
budget or prove that stock SQLite connections can remain open without bound.** The “lesson” column is my
inference for ts-db, not a claim about undocumented vendor internals.

| Platform                               | Documented mechanism                                                                                                                             | Descriptor/concurrency lesson for ts-db                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turso Cloud                            | Database segments fetched lazily; WAL persisted to S3 Express before acknowledgement; local storage is a cache                                   | Separate durable databases from local residency. A remote-page architecture changes storage economics, but caches and network sockets still require budgets. It is not a consequence of choosing Rust or Go |
| Litestream                             | Background asynchronous WAL-page replication, now using LTX files; VFS read-replica support can fetch pages from object storage                  | Improves backup traffic and recovery options. The writer's local connections remain; include the replicator's resources in capacity. A replica is not an answer to writer scheduling                        |
| LiteFS / Fly.io                        | Filesystem interception captures changed pages into LTX; local copies; lease-selected primary; asynchronous replication                          | Preserve SQLite files and route writes to their owner. Replication adds resource use and does not stop a local SQL call blocking its caller                                                                 |
| rqlite                                 | SQLite behind a service, with commands ordered through Raft and snapshots/log compaction                                                         | Moves SQLite ownership into a service and adds consensus durability. Raft files, connections and replicas are additional resources; this is not an fd optimization for millions of app files                |
| dqlite                                 | Embedded server thread, network clients, Raft replication and quorum persistence                                                                 | Good evidence for separating database execution from application callers. Asynchronous network I/O alone says nothing about SQL preemption or fair sharing between apps                                     |
| Cloudflare D1 / SQLite Durable Objects | Each D1 database is backed by a Durable Object; per-database sequential execution, queueing and overload rejection; scale across small databases | Strong support for database-per-app plus admission and placement. A busy database need not imply one universal application event loop; physical fd residency is not specified in the cited docs             |

Sources for the table:

- Turso:
  [durability and segmented storage](https://turso.tech/blog/how-does-the-turso-cloud-keep-your-data-durable-and-safe),
  [diskless architecture](https://turso.tech/blog/turso-cloud-goes-diskless).
- Litestream: [replication design](https://litestream.io/how-it-works/),
  [VFS reference](https://litestream.io/reference/vfs/). The latter documents read access; separate write-mode
  material exists, but is not evaluated here. Avoid the obsolete blanket claim that Litestream only restores
  backups and cannot serve reads.
- Fly.io: [LiteFS design and leases](https://docs.fly.io/litefs/how-it-works).
- rqlite: [current design](https://rqlite.io/docs/design/). Use the current disk/WAL design, not historical
  descriptions of SQLite always running in memory.
- dqlite: [Canonical architecture](https://canonical.com/dqlite/docs/explanation/architecture).
- Cloudflare: [D1 concurrency limits](https://developers.cloudflare.com/d1/platform/limits/),
  [SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/).

Cloudflare's synchronous local SQLite API is an important counterexample to “synchronous SQLite is always
wrong.” The isolation, placement and admission unit matters. Its advertised object-local execution model does
not validate running all of ts-db's tenants through one uninterruptible JS execution thread. Likewise, Turso
Cloud's architecture is evidence for remote durability, not proof that installing a libSQL client reproduces
that platform's fd management or storage service.

## Keep the live-file model; improve its maintenance path

Retain ordinary per-app SQLite files as the initial serving format. Move snapshots out of the mutation queue
onto a separate maintenance connection and process capacity. Prefer incremental online backup when its restart
behavior under concurrent writes is acceptable: copy bounded page batches, yield between batches and limit
I/O. SQLite documents source locking during each step and restart behavior when another connection modifies
the source. Treat completion under sustained writes as a test requirement, not an assumption.
[Online backup API](https://www.sqlite.org/c3ref/backup_finish.html).

This preserves file portability and the existing immutable object/manifest flow without making every snapshot
one large writer-queue job. Read-only `VACUUM INTO` is another candidate, but still needs its own execution
and I/O budget. Never upload a raw copy of an actively changing main database file as if it were a consistent
backup. [SQLite VACUUM INTO semantics](https://www.sqlite.org/lang_vacuum.html).

If full snapshots dominate I/O or the required recovery point tightens, evaluate Litestream-style incremental
shipping before inventing a WAL shipper. Pin and validate its version, checkpoint interaction, restore
continuity, lag and resource use. Asynchronous shipping does not make an acknowledged local write durable in
object storage immediately; the acknowledgement contract must say so.

A Turso-like remote VFS is a later option that can retain one logical database per app while changing where
its pages reside. Its technical costs are remote-read latency, caching, ownership fencing, recovery and
commit-path network dependencies. If a literal portable live file per app remains required, some
remote-storage designs need materialization/export to satisfy that property. Neither remote pages nor
consensus replication is needed to solve the current event-loop and fd-admission failures.

## Make the hybrid boundary explicit

The proposed Go service owns file paths, connection caches, SQL execution, transaction leases, interrupts,
backup work and idempotency records. Deno owns HTTP/authentication and the application-facing TypeScript API.
Requests carry authenticated app identity, deadline, request ID and trace context; clients never choose
arbitrary server file paths. Give results bounded row/byte budgets so serialization cannot become the next
process-wide stall.

There is a substantial semantic seam: the current mutation path invokes a TypeScript definition inside the
transaction. An opaque “execute this function” message is not executable in Go. Two viable designs are a
versioned operation program executed entirely by the storage service, or connection-affine transaction RPCs
while Deno evaluates the definition. The latter keeps arbitrary existing handler logic but adds round trips
and holds the writer lease while application code runs. Put a total deadline on that lease, rollback on client
loss, and preserve expired-context rejection. Prefer one service-side command for common mutations; do not
pretend every current callback can become a single SQL batch automatically.

Keeping Deno is justified by this separation of application execution from native storage and by the smaller
crash domain, not by porting effort. The hybrid's disadvantages are an extra process/protocol, payload
copying, distributed tracing and ambiguous RPC outcomes. Compare its measured latency against an all-Go API
plus the same isolated storage topology before consolidating processes.

## Evidence still needed before implementation selection

This task adds no platform code and ran no new PoC. The source contracts settle whether isolation and native
cancellation are available; they do not settle throughput, fd coefficients for a new binding or tail latency.
Existing work-script harnesses were inspected; none supplies a Go-versus-Rust service comparison. Do not turn
this report into a benchmark claim.

The implementation spike should use the same SQLite version/build options, data, durability settings and SQL
across candidates, record host contention, and cover these gates:

| Experiment                                                         | Required observation                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| One long query on app A, periodic mutation on app B                | API remains responsive; B meets the chosen completion SLO under bounded admitted load                     |
| Saturate the read pool and app-open churn together                 | Protected writer retains queue, execution and fd capacity; bounded rejection elsewhere                    |
| Cancel CPU-heavy query, lock wait and slow extension independently | Record deadline-to-return and resource reclamation separately; supervisor contains non-cooperative work   |
| Race cancellation, connection reuse and commit acknowledgement     | No next-request interruption; transaction cleanup correct; retries return one durable result              |
| Sweep resident apps, readers and storage-process count             | Measure `/proc` fd totals, OS threads, RSS and close latency; validate process and node budgets           |
| Large snapshot during hot writes                                   | Backup progresses without monopolizing writer queue or storage bandwidth; restore passes integrity checks |
| Kill a storage process during a mutation                           | Other processes continue; restart recovers files; request ID resolves commit ambiguity                    |
| Current callbacks through the hybrid transaction protocol          | Preserve conditional mutation semantics, serialization failures before commit and expired-context errors  |

## Document validation

Changed-document formatting and `git diff --check` pass. `deno task ci` stops at its formatting gate: the
unchanged root `README.md` and `docs/architecture/README.md` already fail formatting on baseline `e808983`.
Later CI stages did not run. This research changes no product code and does not claim a new passing test-suite
run. Shared event publication failed because the Git inbox was read-only in the sandbox; further event logging
was skipped as authorized by the user.
