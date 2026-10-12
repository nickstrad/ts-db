# Would a language switch design away the Deno issues? (Fable)

Status: research · Author: Fable 5.1 (with nickstrad) · Date: 2026-10-12 · Branch:
`research/fable-lang-switch` · Code baseline: `main` at `e808983`. Brief: `/root/lang-switch-brief.md`.

## Answer

**No for the core, and the hybrid the brief suggests is already available inside Deno.** Of the three issues,
one is physics that no language changes (file descriptors per connection), one is a property of SQLite's
execution model that every language handles the same way (a statement occupies a thread until SQLite returns),
and only one is a Deno-specific gap: `node:sqlite` exposes a synchronous API with no `sqlite3_interrupt`, over
a library (rusqlite 0.40, bundled into the Deno binary) that has both. Measured on this VM, Deno's FFI reaches
the system `libsqlite3` with a `nonblocking` call that runs on a pool thread, keeps the event loop live, and
is cancelled by `sqlite3_interrupt` from the main thread in about 0.3 ms. That is the same primitive Go, Rust
and C give you, at a 35 to 60 µs per-call cost that only statements which might run long need to pay.

Go's goroutines do not give a fundamentally better execution model for this workload: a cgo call pins an OS
thread exactly as a Deno pool thread is pinned, and the thread count grows one per blocked statement (measured
10 to 21 threads with eight long statements). What Go gives you is a clean cancellation path (context →
`sqlite3_interrupt`, 0.1 to 0.5 ms) and a runtime that keeps other goroutines running. Both are reachable from
Deno by FFI. If a native sidecar is ever justified, Rust with rusqlite is the better choice: it is the library
Deno already embeds, its `Connection` is `Send` with an `InterruptHandle`, and Turso's own database engine is
Rust.

The recommendation, in order: keep Deno for the API and the core; replace `node:sqlite` on the execution path
with an FFI binding that supports nonblocking step and interrupt, run statements that may be long on a bounded
pool with per-statement deadlines, keep point reads synchronous; keep child-process lanes as the crash,
descriptor and CPU isolation unit, not as the cancellation mechanism. Conditions that would reverse this are
listed in §8.

## 1. What the three issues actually are

| Issue (brief)                                | Root cause                                                                                                                                                                                                                                   | Changed by a language switch?                                                                                                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Event-loop blocking; workers not killable | `node:sqlite` is synchronous and runs on the JS thread; Node's reference documents no interrupt, progress handler or statement timeout. `Worker.terminate()` cannot stop native code (24.9 s observed).                                      | **No.** It is an API gap. SQLite itself provides `sqlite3_interrupt`, safe from another thread; Deno's FFI reaches it (§3). Go/Rust/C expose it natively.                                                                          |
| 2. File-descriptor pressure                  | A WAL writer connection opens 3 descriptors (db, `-wal`, `-shm`) and a reader 2. Measured identically from Deno, Go and C (§3). `RLIMIT_NOFILE` is per process.                                                                              | **No.** Same cost in every language. Go raises the soft limit to the hard limit at startup (Go 1.19), which Deno could also do with `prlimit`. The real lever is a bounded handle cache and more processes, both language-neutral. |
| 3. `node:sqlite`'s threading model           | One connection, one thread, serialized by SQLite's own mutex (default `SQLITE_THREADSAFE=1`). A statement occupies a thread until it returns in every binding in every language; the only question is whether that thread is the event loop. | **Partly.** Not the model, which is SQLite's, but the choice of thread. Go, Rust, C and Deno-FFI all let the statement run off the loop.                                                                                           |

The one genuinely Deno-specific fact is that the capability exists one layer down and is not surfaced: Deno's
workspace `Cargo.toml` pins `rusqlite = "0.40.0"` with `bundled`, and rusqlite's `Connection` documents
`get_interrupt_handle()` and `progress_handler()`.

## 2. Method

All numbers below are from this VM (4 vCPUs, 8 GB, Linux 6.8, Deno 2.9.5, Go 1.26.8, gcc 13.3, system
libsqlite3 3.45.1, amalgamation 3.53.4 via the mattn module), measured on 2026-10-12. The committed run
(`lang-switch-fable-data/`) started at load average 3.3, right after its own compile step; an earlier run at
load 0.5 to 1.2 gave the same picture, and where the two differ the text quotes the range. Scripts are under
`work-scripts/` (rows in `work-scripts/INDEX.md`); raw JSON is in
[`lang-switch-fable-data/`](lang-switch-fable-data/). One shared design across C and the three Go drivers: 32
tenant WAL files with 1,000 rows each; K long statements (a recursive CTE that is always cancelled, never
finished) on tenants 0..K−1; eight threads doing point reads on tenants 8..31 for three seconds; cancellation
latency measured from the cancel call to the statement returning. The Deno scripts measure the current
mitigation (child-process lane kill and restart) and the FFI alternative.

## 3. Measurements

### 3.1 Cancelling a running statement and keeping other tenants served

| Runtime / binding                             |    Cancel latency, single statement | Cancel latency, 8 concurrent | Reads on other tenants p50 / p99 (ms), K=1 → K=8 | OS threads, K=8 | fds per connection |
| --------------------------------------------- | ----------------------------------: | ---------------------------: | ------------------------------------------------ | --------------: | -----------------: |
| C, pthread + `sqlite3_interrupt`              |                            0.033 ms |                   0.0–0.1 ms | 0.006 / 0.48 → 0.006 / 0.14                      |    one per stmt |                  3 |
| Go, mattn/go-sqlite3 (cgo)                    |                             0.11 ms |                   0.1–0.3 ms | 0.023 / 2.7 → 0.022 / 5.9                        |         10 → 21 |                  3 |
| Go, ncruces/go-sqlite3 (wasm2go, no cgo)      |                             0.18 ms |                   0.2–0.5 ms | 0.033 / 2.5 → 0.037 / 4.9                        |           7 → 7 |                  3 |
| Go, modernc.org/sqlite (transpiled, no cgo)   |      4.1 ms (1.5 in an earlier run) |                  0.8–16.8 ms | 0.035 / 1.6 → 0.027 / 6.4                        |           8 → 9 |                  3 |
| Deno, FFI `nonblocking` + `sqlite3_interrupt` |      0.41 ms (0.34–8.8 across runs) |                 not measured | loop stayed live: 92–95 ticks of 10 ms in 1 s    |     pool thread |                  3 |
| Deno, `node:sqlite` on the main thread        |         cannot cancel (24.9 s wait) |                            — | blocked for the statement's whole duration       |               1 |                  3 |
| Deno, child-process lane (current mitigation) | 3.8 ms SIGKILL→exit, +51 ms restart |                            — | unaffected (other lanes)                         |       1 process |                  3 |

Reading the table: every native path keeps reads on other tenants in the tens of microseconds while long
statements run; the p99 growth from K=1 to K=8 is CPU contention on four cores (8 long + 8 reader threads),
visible in the C row too, not blocking. Cancellation is sub-millisecond everywhere `sqlite3_interrupt` is
reachable; modernc is slower (1 to 17 ms) because its cancellation is cooperative inside transpiled code. Go's
cgo driver adds one OS thread per blocked statement, as the Go scheduler documents; the two no-cgo drivers do
not, because a statement is Go code the scheduler can preempt. The child-process lane is the only path whose
cost is measured in tens of milliseconds, and it is also the only one that takes every tenant on the lane down
with the statement.

### 3.2 What a point read costs on each Deno path

| Path (same 1,000-row WAL file, prepared statement reused, 20,000 reads) |  p50 µs |    p99 µs |
| ----------------------------------------------------------------------- | ------: | --------: |
| `node:sqlite` synchronous, main thread (today)                          | 8.7–8.9 |     34–36 |
| FFI, blocking `sqlite3_step` on the main thread                         | 6.3–6.8 |     28–31 |
| FFI, `nonblocking` `sqlite3_step` (pool thread + Promise)               |   44–69 | 240–2,180 |

So the nonblocking path is not free: 35 to 60 µs per call and a p99 tail between 0.2 and 2 ms across runs,
from the thread hop and promise resolution. On a 4 ms p50 HTTP path that is invisible at p50 and visible at
p99. The right use is selective: point reads and single-row writes stay synchronous; statements without a
bounded plan (list queries, aggregates, anything with a user-controlled predicate) go nonblocking with a
deadline.

## 4. The Go thread-pool question, answered directly

Would goroutines, channels and errgroup give a fundamentally better execution model for dispatching SQLite
work to a thread pool? The honest answer has three parts.

1. **The execution model is SQLite's, not the language's.** A connection runs one statement at a time on
   whichever thread calls `sqlite3_step`, and that thread is occupied until SQLite returns or is interrupted.
   Goroutines do not change this. With the cgo driver, each blocked statement pins an OS thread; the runtime
   grows threads to keep other goroutines running (measured 10 → 21 with eight long statements) up to its
   10,000-thread default, after which the program aborts. The Go maintainers' position is that the program
   must bound its own concurrent cgo calls, which is a semaphore, the same thing the platform has today in
   `Semaphore(1)` per file and the 32-permit read cap.
2. **What Go does give you is ergonomics around the right primitives.** `QueryContext` wires context
   cancellation to `sqlite3_interrupt` (0.1 to 0.5 ms measured with mattn and ncruces); `errgroup.SetLimit` is
   a bounded pool in one line; `database/sql` pools connections per file; the runtime raises `RLIMIT_NOFILE`
   for you. None of these is unavailable elsewhere; Go makes them the default shape of the code.
3. **The no-cgo drivers change the thread story but not the cost.** modernc and ncruces run SQLite as Go code,
   so a long statement is a preemptible goroutine and the thread count stays flat. The price is 1.3 to 2× CPU
   per statement (modernc's own figures against native C) and, for modernc, cooperative cancellation measured
   at 1 to 17 ms. For a platform whose hot path is one write per minute and point reads at 9 µs, neither cost
   matters much, but neither is "fundamentally better" than a native thread pool.

Against Deno plus child processes specifically: Go's advantage is cancellation at 0.1 ms versus kill-and-
restart at 55 ms, and statement-level rather than lane-level blast radius. Deno plus FFI closes that gap
(§3.1). What child processes still provide, in any language, is isolation from a native crash (the repo's own
segfault history in the DuckDB child is the reminder) and a separate descriptor table.

## 5. Per-language assessment, ignoring coding cost

Criteria from the brief: execution model, SQLite binding quality, descriptor handling, concurrency primitives,
operational characteristics.

### Go

- **Execution model.** Goroutines over a thread pool; cgo pins a thread per statement, no-cgo drivers do not.
  Preemptive scheduler keeps the HTTP side responsive under any mix.
- **Bindings.** Three mature choices measured here: mattn (cgo, fastest, bundled amalgamation), ncruces
  (wasm2go, no cgo, interrupt at 0.2 to 0.5 ms, higher memory per connection by design), modernc (transpiled,
  no cgo, widest adoption, slower cancellation, fragile `libc` version pinning noted in its own docs).
- **Descriptors.** Same 3 per writer; runtime raises the soft limit to the hard limit; `database/sql` pools
  per file with `SetMaxOpenConns`.
- **Concurrency primitives.** Context cancellation into `sqlite3_interrupt` is the single best ergonomic win;
  `errgroup`, semaphores and channels are standard.
- **Operational.** Static binary, small RSS, mature HTTP stack, pprof. Thread exhaustion under unbounded cgo
  is the one runtime failure mode to design against.
- **Verdict.** Viable and pleasant; nothing in it is unreachable from Deno for this workload.

### Rust

- **Execution model.** Tokio with `spawn_blocking` for statements (default pool up to 512 threads), or the
  sqlx pattern of one dedicated thread per connection with a command channel.
- **Bindings.** rusqlite is the reference binding and the one Deno itself ships (0.40, `bundled`).
  `Connection: Send + !Sync`, `get_interrupt_handle()`, `progress_handler()`, `busy_timeout()`. sqlx wraps it
  asynchronously. Turso's rewritten database engine is Rust with io_uring-based async I/O, still in beta,
  single writer.
- **Descriptors.** Same costs; no automatic limit raise; `rlimit` crate or `prlimit` at startup.
- **Concurrency primitives.** The type system enforces the one-connection-one-thread rule (`!Sync`) that every
  other language leaves to discipline; `spawn_blocking` closures cannot be cancelled, which is exactly why the
  interrupt handle exists.
- **Operational.** Static binary, lowest RSS, no GC pauses, slowest builds. A native crash in the sidecar
  takes only the sidecar.
- **Verdict.** The strongest native option on technical merit, because it is the library already under Deno's
  `node:sqlite` and the direction Turso chose. If a sidecar is ever built, build it here.

### Zig

- **Execution model.** Manual threads; `std.Thread.Pool` exists; no async runtime in the standard library at
  present.
- **Bindings.** zig-sqlite (vrischmann) is the main binding; its maintainer states they are on a break from
  Zig and plan only compatibility updates; last activity found March 2025; "the API may change". C interop is
  trivial, so `sqlite3_interrupt` is one declaration away.
- **HTTP.** `std.http.Server` is documented by the community as minimal and single-threaded; the third-party
  servers (zap, http.zig) describe themselves as alpha or experimental, tracking a language that breaks APIs
  between 0.x releases.
- **Verdict.** Technically capable of the SQLite part, not of hosting the API tier; no advantage over C for a
  sidecar and a much smaller ecosystem.

### C

- **Execution model.** Whatever you build; the floor measured here is 0.025 ms interrupt latency and 6 µs
  point reads with eight long statements running on four cores.
- **Bindings.** The library itself; nothing to assess.
- **Descriptors, concurrency, operational.** All manual; every safety property is discipline, and the HTTP
  tier would be a third-party server library.
- **Verdict.** The reference point, not a destination. Everything measured above is within 10× of it in Go,
  Rust and Deno-FFI.

### Deno, staying put (the baseline)

- `node:sqlite` as used today: synchronous, main thread, no interrupt. Node's own `node:sqlite` has the same
  shape; the asynchronous `sqlite3` npm package (libuv pool, `interrupt()` documented) and `better-sqlite3`
  (synchronous, worker-thread pattern) are the two Node alternatives, neither better than FFI here.
- Deno FFI to `libsqlite3`: measured, works without an unstable flag on 2.9.5; `@db/sqlite` 0.13 is the
  maintained FFI binding but exposes no `interrupt()` or nonblocking mode, so the platform would own a small
  binding of its own (the probe is 40 lines).
- Deno Web Workers: liveness but not cancellation (24.9 s).
- Child processes: cancellation by SIGKILL at 55 ms per lane cycle, with lane-wide blast radius.

## 6. What other platforms do about descriptors and many databases

| Platform                        | Shape                                                                                                                                                                                                                                                                                                                                | Language | Descriptor strategy                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------- |
| Turso Cloud                     | Per-tenant SQLite on diskless nodes; WAL persisted to S3 Express before a commit is acknowledged; local disk is a cache, checkpoint about every 1 MB; WAL writes from many databases on a node batched for a few ms per upload. Active-database limit removed from paid plans.                                                       | Rust     | Open on demand; the node is a cache, so the working set, not the catalogue, bounds open files.  |
| Cloudflare Durable Objects / D1 | One SQLite per object, running in the same thread as the isolate; synchronous SQL API; writes stream through a VFS to a storage relay (batches up to 10 s or 16 MB, five followers, three acks); objects started on request and shut down when idle; 10 GB per object; each D1 database is one Durable Object; 30 s CPU per request. | C++      | Objects are evicted when idle, so open files track live objects; unlimited objects per account. |
| Litestream 0.5                  | Backup by WAL shipping (LTX); VFS read replicas fetching pages on demand from object storage, polling every 1 s; "not high-concurrency OLTP".                                                                                                                                                                                        | Go       | One process per primary database; replicas hold no live file at all.                            |
| LiteFS                          | FUSE filesystem, Consul lease elects one primary, async replication; maintainer: "nothing in the design limits the number of databases", overhead is "total database size and concurrent connections"; tens of thousands untested at the time.                                                                                       | Go       | FUSE layer, no per-database handle reservation.                                                 |
| rqlite / dqlite                 | Raft over one database per cluster (statement-based with `RANDOM()` rewriting; frame-based C library). Not a many-databases design.                                                                                                                                                                                                  | Go / C   | Not applicable.                                                                                 |
| Convex                          | One serial committer per deployment, read-only function runners scaled out (rendezvous hashing); no published mutations-per-second threshold.                                                                                                                                                                                        | Rust     | One database per deployment.                                                                    |

Two patterns cover every platform that hosts many databases: open on demand with a bounded working set (Turso,
Cloudflare, the SQLite forum's practitioners), and make the node a cache by streaming the WAL to object
storage so a cold database costs a fetch, not a descriptor (Turso, Cloudflare's relay, Litestream's VFS).
Nobody solves descriptors with a language; the two Go systems and the Rust one hold the same 3 per writer.

## 7. Challenging the live-file plus object-store-copy architecture

The research points at one alternative worth naming: **WAL-streamed storage with local disk as cache** (Turso,
Cloudflare's storage relay, Litestream's writable VFS). Under the three constraints:

- _Descriptors per node_ stop being a placement constraint and become a cache-sizing constraint; any node can
  serve any tenant after a fetch. That dissolves most of the control plane in the scale-out ranking.
- _Hot write never starved_ gets harder, not easier: the acknowledgement now waits on an object-store round
  trip (Turso measured 6.4 ms average to S3 Express against 2 ms for a local fsync), and the mitigation is
  cross-tenant batching, which is a shared queue.
- _No statement blocks everyone_ is untouched; it is an execution-thread question in either architecture.

It is also the most expensive thing on the table in any language: a VFS or a WAL interceptor, a relay with
quorum acks, snapshot plus log compaction, and a recovery protocol. Litestream's writable VFS is the nearest
off-the-shelf piece and is single-writer, 1 s stale, and "not for OLTP". The honest position is the one the
scale-out ranking took: keep live files and the verified snapshot pipeline; add WAL frames to the object store
as phase two for recovery point; reconsider the diskless shape only if placement itself becomes the
operational burden. It does not interact with the language question.

## 8. Bottom line

**Do not switch languages for the core.** Keep Deno for the API server and the core logic. Do the hybrid
inside the process first:

1. Replace `node:sqlite` on the statement execution path with an FFI binding to `libsqlite3` (own code, ~200
   lines, or a contribution of `interrupt()` and nonblocking step to `@db/sqlite`). Pin the library version;
   the system library is 3.45.1 while the CLI and the Go amalgamation are 3.53.4.
2. Run point reads and single-row writes synchronously (6.8 µs, faster than today) and every statement without
   a bounded plan through `nonblocking` step on a bounded pool with a per-statement deadline enforced by
   `sqlite3_interrupt` from the main thread (0.4 ms). Budget a p99 tail of up to 2 ms.
3. Keep child-process lanes for what only a process gives: a native crash does not take the API down, a
   separate descriptor table, and CPU isolation that a shared pool cannot provide. Lanes are no longer the
   cancellation mechanism, so they can be fewer and larger.

**Build a native sidecar only if one of these becomes true:** the FFI pool's p99 tail is unacceptable at the
HTTP layer after measurement under load; a native crash inside the API process is observed and process lanes
are judged too coarse; or the platform adopts WAL streaming (§7), at which point the sidecar is a storage
engine and Rust with rusqlite, the library Deno already ships, is the choice. Go is a reasonable second. Zig
and C are not candidates for the API tier and bring nothing over Rust for the storage tier.

What a switch would not change under any choice: 3 descriptors per writer, one statement per thread, one
writer per file, and the need for a bounded handle cache and explicit placement across nodes.

## 9. Open items and limits of this study

- Rust and Zig were assessed from primary documentation, not measured; neither toolchain is on this VM. The C
  and Go floors bound what rusqlite can do (it calls the same functions).
- The FFI probe uses `SQLITE_OPEN_FULLMUTEX` and one connection; a production binding would need a
  connection-per-pool-thread discipline and `UnsafePointer` hygiene reviewed under the repo's Opus review.
- Deno documents nonblocking calls as running "on a dedicated blocking thread"; the pool's size and
  back-pressure behaviour under hundreds of concurrent long statements were not measured.
- The 24.9 s worker figure and the 3/2 descriptor costs are from the scale-out study on 2026-10-12 and were
  reproduced here by the Go and C harnesses (3 per writer connection).
- A separate Astra study of the same question exists on `research/astra-lang-switch`; it was not read for this
  document.

## Sources

SQLite: [sqlite3_interrupt](https://www.sqlite.org/c3ref/interrupt.html) ·
[threading modes](https://www.sqlite.org/threadsafe.html) · [WAL](https://www.sqlite.org/wal.html) ·
[VACUUM](https://www.sqlite.org/lang_vacuum.html)

Node / Deno: [node:sqlite reference](https://nodejs.org/api/sqlite.html) ·
[Deno workspace Cargo.toml (rusqlite 0.40 bundled)](https://raw.githubusercontent.com/denoland/deno/main/Cargo.toml)
· [Deno FFI, nonblocking symbols](https://docs.deno.com/runtime/reference/deno_namespace_apis/) ·
[@db/sqlite 0.13 API](https://jsr.io/@db/sqlite/doc/~/Database) ·
[node-sqlite3 API (interrupt)](https://github.com/TryGhost/node-sqlite3/wiki/API) ·
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

Go: [Go 1.19 release notes, RLIMIT_NOFILE](https://go.dev/doc/go1.19) ·
[runtime thread limit (issue 4056 / commit 665feeed)](https://golang.org/issue/4056) ·
[modernc.org/sqlite](https://pkg.go.dev/modernc.org/sqlite) ·
[ncruces/go-sqlite3](https://pkg.go.dev/github.com/ncruces/go-sqlite3) ·
[mattn/go-sqlite3](https://github.com/mattn/go-sqlite3)

Rust: [rusqlite Connection](https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html) ·
[sqlx SQLite worker model](https://docs.rs/sqlx/latest/sqlx/sqlite/struct.SqliteConnection.html) ·
[tokio spawn_blocking](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html) ·
[Turso Database (Rust rewrite)](https://turso.tech/blog/turso-the-next-evolution-of-sqlite)

Zig: [zig-sqlite README](https://raw.githubusercontent.com/vrischmann/zig-sqlite/master/README.md) ·
[http.zig](https://github.com/karlseguin/http.zig) · [zap](https://github.com/zigzap/zap)

Platforms:
[Turso on S3 Express (AWS)](https://aws.amazon.com/blogs/storage/how-turso-built-a-transactional-database-using-amazon-s3-express-one-zone/)
· [What is Turso?](https://turso.tech/what-is-turso) ·
[SQLite in Durable Objects (Cloudflare)](https://blog.cloudflare.com/sqlite-in-durable-objects/) ·
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) ·
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ·
[Litestream VFS](https://litestream.io/how-it-works/vfs/) ·
[LiteFS and many databases (Fly community)](https://community.fly.io/t/litefs-many-tens-to-hundreds-of-thousands-of-sqlite-dbs/9977)
· [Introducing LiteFS](https://fly.io/blog/introducing-litefs.md) ·
[rqlite non-deterministic functions](https://rqlite.io/docs/api/non-deterministic/) ·
[dqlite FAQ](https://canonical.com/dqlite/docs/explanation/faq) ·
[How Convex Works](https://stack.convex.dev/how-convex-works) ·
[Convex: horizontally scaling functions](https://stack.convex.dev/horizontally-scaling-functions) ·
[SQLite forum: thousands of databases per user](https://sqlite.org/forum/forumpost/939c555daeb34818)
