# File descriptor limits and management: landscape (Ubuntu / Linux)

Status: research draft, 2026-10-12. Host for measurements: vm-1 (Ubuntu 24.04-era userspace, kernel 6.8.0-139, Deno 2.9.5, SQLite 3.53.4, Python 3.53.4 sqlite module).

Tags: **[V]** verified in this session against a fetched primary source or a local measurement. **[M]** measured locally (command and result given). **[U]** unverified: general knowledge or a search snippet that did not confirm it. Treat [U] items as leads, not facts.

## Summary

- The fd budget per connection is what matters: a WAL-mode writer holds 3 fds (db, `-wal`, `-shm`) and a read-only connection holds 2 **[M, Deno and Python agree]**. A capacity formula is `3 × writers + 2 × readers + reserved`, not one per file.
- On vm-1 the per-process soft limit is 1,048,576 **[M]**, so descriptor limits are not binding here. The brief says the production server is hitting its practical limit. That production limit is not on this host. Before tuning, read the real limit of the server's process (`/proc/<pid>/limits`, the systemd unit's `LimitNOFILE`, and any container limit). Our host is not evidence about that process.
- When the limit is hit, `open(2)` fails with `EMFILE` (per process). SQLite reports it as `SQLITE_CANTOPEN` **[M]**. `ENFILE` (system-wide table full) was not reached and is far off here (2,368 of 9.2 × 10^18 in use) **[M]**.
- Keep the writer connection open. Put only readers behind an LRU or idle-expiry pool. An idle expiry shorter than the write interval makes every write reopen the WAL and checkpoint it **[V, sqlite.org/wal.html]**.
- Create every descriptor with its `*_CLOEXEC` form. Go ≥ 1.19 raises the soft limit to the hard limit automatically **[V]**; Rust std and Node do not, so check the limit explicitly in those runtimes **[U]**.
- No mainstream database uses an fd pool with the same shape as ours. Postgres caps per backend (`max_files_per_process`, default 1000) and pools at the connection level with PgBouncer. SQLite leaves handle management to the application. Turso hosts many databases in one process and does not document a per-database fd cap **[U]**.

## 1. Ubuntu fd limits

### 1.1 Layers

| Layer | Knob | Value on vm-1 | Notes |
|---|---|---|---|
| Per process, soft | `ulimit -n`, `RLIMIT_NOFILE` soft | 1,048,576 [M] | Enforced per process; `EMFILE` on exceed |
| Per process, hard | `ulimit -Hn` | 1,048,576 [M] | Soft may be raised up to hard without privilege |
| Kernel per-process ceiling | `fs.nr_open` | 1,048,576 [M] | Upper bound for `RLIMIT_NOFILE`; `setrlimit` above it fails |
| System-wide | `fs.file-max` | 9,223,372,036,854,775,807 [M] | Table size; `ENFILE` when exhausted |
| System-wide in use | `/proc/sys/fs/file-nr` | `2368 0 9223372036854775807` [M] | allocated, free-but-allocated, max |
| systemd default for units | `DefaultLimitNOFILE` | 524,288 [M] (`systemctl show`) | Applies to services started by systemd; a user session can differ |
| Login sessions | `/etc/security/limits.conf`, `limits.d/` | no custom entries found [M] | PAM applies these to login sessions |
| cgroup | `pids.max`, memory and IO controllers | no fd controller exists in cgroup v2 [U] | fds are not a cgroup-accounted resource; the limit is `RLIMIT_NOFILE` |

Local check of the current process: `grep 'Max open files' /proc/self/limits`, and `ls /proc/<pid>/fd | wc -l` for usage [M, used on this host].

Ordering that matters in practice: the effective limit is the smallest of the soft `RLIMIT_NOFILE` of the process and `fs.nr_open`. systemd `LimitNOFILE` sets the soft and hard limits of the unit; if a unit sets only `LimitNOFILE=` with one value, both are set to it **[U, from systemd.exec(5); not fetched]**.

### 1.2 What happens at the limit

- `EMFILE` ("Too many open files"): the process reached `RLIMIT_NOFILE`. Measured: a process with soft limit 64 opened 61 descriptors and then got `EMFILE` with the message `Too many open files` **[M, python `os.open` loop]**. The same at 1024 opened 1021 **[M]** (the baseline already held 3).
- SQLite at the limit: opening 20 writer connections under a 64-fd limit failed on the first connection that could not get an fd, with `sqlite3.OperationalError: unable to open database file` (`SQLITE_CANTOPEN`) **[M]**. The mapping from `EMFILE` to plain `SQLITE_CANTOPEN` in the unix VFS was not confirmed in source **[U]**; the observed error is what matters for handling.
- `ENFILE`: the system-wide table is full. Not reproducible here at this scale. Unlikely on a host with `fs.file-max` near 2^63 **[M, value]**.
- `setrlimit` above `fs.nr_open` fails; `RLIMIT_NOFILE` soft may be raised without privilege up to the hard limit **[V, getrlimit(2)]**.

### 1.3 Inspecting usage

- Per process: `ls /proc/<pid>/fd | wc -l` and `cat /proc/<pid>/limits` **[M]**.
- Per process, by type: `ls -l /proc/<pid>/fd` (symlink targets show `socket:`, `anon_inode:`, `*.db-wal`, etc.) **[M]**.
- `/proc/<pid>/status` has an `FDSize` line (the size of the fd table, not the number open); the `fd` directory gives the actual count **[U, from proc(5) recall; not fetched]**.

## 2. Syscall level

### 2.1 dup / dup2 / dup3 [V, dup(2)]

- `dup(oldfd)` returns the lowest free fd; the new fd has `FD_CLOEXEC` cleared.
- `dup2(oldfd, newfd)` closes `newfd` if open. If `oldfd == newfd`, it does nothing and returns `newfd`.
- `dup3(oldfd, newfd, flags)` (Linux 2.6.27, glibc 2.9) accepts only `O_CLOEXEC` and fails with `EINVAL` when `oldfd == newfd`.

### 2.2 close_range(2) [V, close_range(2)]

- Linux 5.9; glibc 2.34 wrapper; needs `_GNU_SOURCE`.
- `CLOSE_RANGE_CLOEXEC` and `CLOSE_RANGE_UNSHARE` since 5.11.
- `close_range(3, ~0U, CLOSE_RANGE_CLOEXEC)` in a child between `fork` and `exec` marks all high fds close-on-exec without walking `/proc/self/fd`.
- Errors: `EINVAL` (bad flags or `first > last`), `EMFILE` (with `UNSHARE`, when open count exceeds `nr_open`), `ENOMEM`.

### 2.3 O_CLOEXEC and the fork/exec race [V, open(2)]

- `O_CLOEXEC` (2.6.23) sets close-on-exec atomically at open time. Without it, a thread that calls `open()` and then `fcntl(F_SETFD)` can leak the fd into a child that another thread `fork`+`exec`s in between.
- Atomic variants: `pipe2(O_CLOEXEC)` (2.6.27); `accept4(SOCK_CLOEXEC)` (2.6.28); `eventfd2(EFD_CLOEXEC)` (2.6.27); `timerfd_create(TFD_CLOEXEC)` (flags 2.6.27); `recvmsg(MSG_CMSG_CLOEXEC)` (2.6.23). `socket(SOCK_CLOEXEC)` version **[U]**. `signalfd4(SFD_CLOEXEC)` details **[U]** (man page did not fetch).
- Rule: use a `*_CLOEXEC` form wherever one exists; use `close_range(..., CLOSE_RANGE_CLOEXEC)` only for fds inherited from elsewhere.

### 2.4 pidfd [V, pidfd_open(2), pidfd_send_signal(2)]

- `pidfd_send_signal` (5.1) and `pidfd_open` (5.3); `PIDFD_NONBLOCK` (5.10); `PIDFD_THREAD` and signal-scope flags (6.9).
- One fd per watched child. Replaces SIGCHLD plus `waitpid` for race-free tracking and avoids PID-reuse races (a reaped pid gives `ESRCH`).
- `pidfd_getfd`: introduced around 5.6 **[U]**.

### 2.5 eventfd / signalfd / timerfd: fd cost

| Object | fd cost | Replacement |
|---|---|---|
| eventfd | 1 | a pipe (2 fds) or socketpair (2 fds) |
| signalfd | 1 | self-pipe written from a signal handler (2 fds plus a handler per signal) |
| timerfd | 1 per timer | user-space timer wheel plus one fd for the loop's `epoll_wait` timeout |

All three are ordinary fds and count against `RLIMIT_NOFILE` **[V, eventfd(2) lists EMFILE for the per-process limit]**.

### 2.6 io_uring and fds

**Registered (fixed) files** [V, io_uring_register(2)]:

- `IORING_REGISTER_FILES` (5.1): a table of fds. Requests use `IOSQE_FIXED_FILE` with the table index. Entries may be `-1` (sparse). `IORING_REGISTER_FILES_UPDATE` fills slots later.
- `IORING_REGISTER_FILES2` (5.13): tagged registration. `IORING_REGISTER_FILE_ALLOC_RANGE` (6.0).
- Registration returns `EMFILE` if it would push the user's references past `RLIMIT_NOFILE`, unless the caller has `CAP_SYS_RESOURCE`. The man page describes this check only at registration **[V]**. Whether a registered slot keeps counting after the original fd closes is **[U]**.
- Maximum table size: `IORING_MAX_FIXED_FILES = 1 << 20` in recent source **[U, version unknown]**.

**Effect on the fd story**: a fixed file is referenced by the ring, not by a process fd. It saves per-I/O fd lookup and keeps the process fd table smaller, but the file stays open while registered. Registration is a one-time, per-user-limit-checked cost.

**Ring fd**: `io_uring_setup` returns one fd per ring. `IORING_SETUP_REGISTERED_FD_ONLY` (6.5) returns a registered index, so the ring does not occupy a process fd slot **[V, io_uring_setup(2)]**.

**Sysctl** `kernel.io_uring_disabled` [V, kernel.org]:

- `0`: any process may create rings (default in the upstream kernel).
- `1`: only processes in `io_uring_group` or with `CAP_SYS_ADMIN` may create rings; existing rings work.
- `2`: `io_uring_setup` always fails; existing rings work.
- Mainline version of the knob: believed 6.6 **[U]**. Canonical backported it to 6.1-based kernels **[U]**. Ubuntu 24.04 default **[U]**.
- On vm-1: `kernel.io_uring_disabled = 0` **[M]**. Production hosts may differ; check before depending on io_uring.

### 2.7 SCM_RIGHTS fd passing [V, unix(7), recvmsg(2)]

- Received fds count against the receiver's `RLIMIT_NOFILE`. Excess received fds are closed automatically, and `MSG_CTRUNC` is set if the control buffer was too small.
- In-flight fds (sent, not yet received) can exceed the sender's limit; the kernel returns `ETOOMANYREFS` unless the sender has `CAP_SYS_RESOURCE`.
- `SCM_MAX_FD` is 253 per message (255 before 2.6.38). Exceeding it gives `EINVAL` from `sendmsg`.
- `MSG_CMSG_CLOEXEC` marks received fds close-on-exec atomically; without it they are inheritable across exec.

## 3. Libraries and runtime fd handling

### 3.1 Go

- **Auto-raise of RLIMIT_NOFILE** since Go 1.19 **[V, go.dev/doc/go1.19]**: programs that import `os` raise the soft limit to the hard limit on Unix. Caveat from the release notes: C child processes that depend on a low limit can inherit the raised one; set the hard limit before starting the Go program to avoid this.
- **netpoller**: registers non-blocking fds with epoll/kqueue and parks goroutines, not threads. It caches `pollDesc` structs, not fds **[V, runtime/netpoll.go]**.
- **os.File finalizer**: the GC may close a leaked `*os.File`; the docs say so explicitly **[V, pkg.go.dev/os#File]**. Finalizers are not a timely release mechanism.
- **database/sql** [V, pkg.go.dev/database/sql]: `SetMaxIdleConns` default 2; `SetConnMaxIdleTime` default off (no idle expiry). `SetMaxOpenConns` default unlimited **[U]**.

### 3.2 Rust

- Tokio/mio: fds are owned by the wrapping type (`TcpStream`, `File`); mio registers fds with epoll/kqueue and does not cache them **[U]**.
- `std::fs::File` closes on drop and ignores close errors **[U]**.
- **RLIMIT_NOFILE**: Rust std does not raise the soft limit **[U]**. Deno's own `unix_util.rs` raises soft to hard **[U, read from the Deno source, not run here]**; crates such as `rlimit` wrap the call **[U]**.

### 3.3 Node.js / Deno (libuv)

- libuv `uv_fs_open` is a thin wrapper over `open(2)`; the caller holds the raw fd and must close it **[V-snippet, docs.libuv.org]**.
- Node does not cache fds; `FileHandle`s from `fs.promises` close on GC with a warning in newer Node **[U]**.
- Deno raises the soft limit at startup **[U, whether this runs by default in the CLI is not verified]**. This matters for the server: check `/proc/<pid>/limits` to see what it actually got.

### 3.4 Pool libraries and their eviction defaults

| Library | Idle expiry | Max lifetime | Other |
|---|---|---|---|
| Go database/sql | off by default [V] | off by default [U] | max idle 2 [V]; max open unlimited [U] |
| HikariCP | `idleTimeout` 600000 ms [V-snippet, mirror] | `maxLifetime` 1800000 ms [V-snippet] | applies only when `minimumIdle < maximumPoolSize` |
| r2d2 (Rust) | 10 min [V-snippet] | 30 min [V-snippet] | may outlive each by up to 30 s |
| bb8 / deadpool | [U] | [U] | check docs.rs |
| SQLAlchemy QueuePool | n/a | `pool_recycle` default -1 (off) [V] | `pool_size` 5, `max_overflow` 10, `pool_timeout` 30 s [V] |

No general-purpose fd cache exists in the standard libraries surveyed. Fd caching is always an application decision.

## 4. How databases deal with it

### 4.1 SQLite [V unless marked]

- **Files per connection**: the db file, plus `-wal` and `-shm` in WAL mode. Rollback-journal mode opens `-journal` during writes. **Measured: 3 per WAL writer, 2 per read-only connection** in both Deno and Python [M]. Exact internal fd accounting in `unixFile`: [U].
- **Inode sharing**: the unix VFS keeps a process-wide list of `unixInodeInfo` (one per device+inode) for lock bookkeeping. Each connection still holds its own fd **[U, from os_unix.c fragments]**.
- **POSIX lock hazard**: POSIX advisory locks are per process. `close()` on any fd to the file drops SQLite's locks for all connections in the process. Never call bare `close()` on a SQLite database file while connections are open [V, howtocorrupt.html].
- **Lock VFS options**: `unix` and `unix-excl` are the compatible choices; `unix-dotfile` uses dot-file locks; `unix-none` does no locking and corrupts under concurrent use [V, vfs.html].
- **Limits**: `SQLITE_MAX_ATTACHED` default 10, max 125 [V, limits.html]. No open-fd limit and no cap on open connections.
- **Idle connections**: SQLite never closes idle connections; there is no timeout pragma and no fd-cache pragma [V, pragma.html]. The application owns connection lifetime.
- **Last close**: the last connection checkpoints and deletes `-wal` and `-shm` [V, wal.html]. Deleting them by hand while a connection is open can lose commits [V]. WAL mode is persistent across opens [V].
- **Page cache**: `cache_size` default about 2 MB per connection (-2000 KiB) [V, pragma.html]. A reopened connection starts with an empty cache.
- **Open failures**: `SQLITE_CANTOPEN` with extended codes; `SQLITE_IOERR_SHMOPEN` for shm mapping failures [V, rescode.html]. Observed under fd exhaustion: `SQLITE_CANTOPEN` [M].

### 4.2 PostgreSQL

- One OS process per backend. `max_connections` typically 100 [V]; `superuser_reserved_connections` 3 [V].
- `max_files_per_process` default 1000, per backend; files opened in the postmaster are not counted [V, runtime-config-resource].
- The backend's `fd.c` virtual-fd layer closes least-recently-used real fds when over the limit **[U, recalled; check `src/backend/storage/file/fd.c`]**.
- PgBouncer pools at the connection level in session, transaction or statement mode; about 2 kB per client connection by default [V, pgbouncer.org/features].

### 4.3 DuckDB

- One read-write process per database file; many read-only processes [V, concurrency docs].
- File locks coordinate access. DETACH releases the file lock; closing a connection does not, because the main instance holds the handles [V, attach docs].
- A transaction writes to one attached database [V].
- Per-attached-database fd count, buffer manager eviction and default memory limit: [U].

### 4.4 Turso / libSQL

- `libsql-server` hosts many logical databases in one process. A Turso benchmark reported 100,000 databases in one instance at about 1.6 GB [V-snippet, Turso blog].
- Per-database fd count and any cap: [U].
- Plan-level caps on databases per account (500, 10,000) appear in a launch-week post; treat as stale [U].

### 4.5 rqlite, dqlite, LiteFS

- **rqlite**: one Raft-replicated SQLite database per cluster, not per tenant. The design doc did not fetch (404) [U].
- **dqlite**: runs SQLite with an in-memory VFS for database pages; the Raft log is on disk. This suggests no per-database disk fd, but the source was not checked [U]. Single-threaded loop per node [search summary, U].
- **LiteFS**: FUSE passthrough that intercepts SQLite writes to record LTX transactions; beta; database deletion not yet implemented [V, superfly/litefs README]. Per-file fd handling in FUSE and multi-database behaviour: [U].

### 4.6 Comparison

| System | Fd model | Pooling | Eviction / idle close | Sharding / tenancy |
|---|---|---|---|---|
| SQLite | 2–3 per connection [M] | none (app) | none; cache shrinks under memory pressure | one file per DB |
| PostgreSQL | one process per backend; 1000 files per backend [V] | PgBouncer | backend exits on disconnect; virtual-fd LRU [U] | schema/DB level |
| DuckDB | per attached DB, held by main instance | none documented | not documented | ATTACH; one write target per transaction |
| Turso / libsql-server | per DB [U] | server-side [U] | [U] | database-per-tenant |
| rqlite | one DB per cluster | Raft | [U] | not per tenant |
| dqlite | in-memory VFS; Raft log on disk [U] | [U] | [U] | [U] |
| LiteFS | FUSE per open file [U] | n/a | [U] | multi-DB under one mount [U] |

Who shards: Turso and SQLite (one file per DB). Who pools: PgBouncer, for Postgres only. Who evicts: SQLite's page cache under memory pressure, Postgres's virtual-fd cache [U], DuckDB's buffer manager [U].

## 5. Resource pool designs for fds and handles

### 5.1 What breaks under eviction

- **Eviction mid-transaction.** Closing a SQLite connection with an open write transaction rolls it back [U, general SQLite behaviour; not re-read from the docs here]. Pinning must cover handles with open transactions, not only handles with an active call.
- **Close under the writer lock.** Closing while holding the app's writer lock makes all writers wait for the close and any checkpoint it triggers. Detach the handle from the cache under the lock; close after releasing it.
- **Last-close checkpoint.** Closing the last connection checkpoints the WAL and deletes `-wal` and `-shm`. Cost is proportional to WAL size. The next open rebuilds the wal-index and starts with an empty page cache [V, wal.html; cost figures U].
- **The 60-second writer.** A writer that writes once a minute, behind an idle expiry shorter than 60 s, reopens on every write. Each cycle pays: reopen and schema setup [U, milliseconds]; a cold page cache [U]; a checkpoint and `-wal`/`-shm` churn [V]; and POSIX lock collisions on `-shm` with other writers in the gap, which are absorbed only with `busy_timeout` [U on the default].
  - Fix: keep the writer open outside the LRU; set idle expiry above the write interval (a few minutes); set `busy_timeout` explicitly.
- **Fd exhaustion inside the cache.** The cache is not the only fd user: sockets, logs and child processes count too. Budget `limit − reserved` and give the rest to handles.

### 5.2 Design patterns

- **Lease with refcount**: `acquire()` increments, `release()` decrements; evictable only at zero. Go's `database/sql` does this with `Conn` [V-behaviour from docs].
- **Two-tier LRU with pinning**: tier 1 holds pinned handles (refcount > 0 or open transaction) and is never evicted; tier 2 is the idle LRU. Eviction runs on release or when an open would exceed budget. If everything is pinned, the open waits on a semaphore rather than failing.
- **Admission semaphore sized to the fd budget**: e.g. `min(soft limit / 2, configured)`. Acquire before open, release after close. Go's `SetMaxOpenConns` and HikariCP's `maximumPoolSize` are this pattern.
- **Reader/writer split**: a bounded read pool with idle expiry; one writer handle kept open with no expiry. This matches SQLite's single-writer model.
- **Singleflight on open**: concurrent misses on the same path share one open. `golang.org/x/sync/singleflight` [U, API not fetched].

## 6. What this means for ts-db

Assuming the production server holds one database per tenant and one writer per active tenant:

1. **Budget formula**: `fds ≈ 3 × active_writers + 2 × pooled_readers + sockets + logs + reserved`. Measure the real process limit first (section 1.3); the 1,048,576 on vm-1 does not apply to the server.
2. **Writers**: keep each tenant's writer open while the tenant is active. Do not put writers behind an idle-expiry LRU shorter than the write interval.
3. **Readers**: pool with an idle expiry (minutes) and a cap sized to the fd budget. Pin any reader with an open transaction.
4. **Failure mode**: when `open` fails, expect `SQLITE_CANTOPEN` from the driver and surface it as a retryable error, not a crash. Log the open-fd count (`/proc/self/fd`) when this happens.
5. **Worker isolation** does not change the fd math. The kb records that Deno's `node:sqlite` call cannot be interrupted from `worker.terminate()`, and that an FFI route with `sqlite3_interrupt` is the workaround [kb: deno-node-sqlite-worker-terminate-and-fd-cost]. That is a separate concern from fd budgeting.

## 7. Open questions

- What is the production server's real `RLIMIT_NOFILE`, and what does the systemd unit set? (Blocks the budget formula.)
- Does Deno's startup raise the soft limit in the CLI as shipped? Check `/proc/<pid>/limits` on a running server.
- Per-connection fd count in the unix VFS, and whether `EMFILE` maps to `SQLITE_CANTOPEN` or another code in the Deno build: confirm with an fd-limit test against the server, not just the Python module.
- io_uring is enabled here (`kernel.io_uring_disabled = 0`). Production value: unknown.
- DuckDB, Turso, dqlite and LiteFS fd behaviour: all rated [U] above; needs source reads before any design depends on them.

## Method and sources

Local measurements (vm-1): `ulimit -n`, `ulimit -Hn`, `/proc/sys/fs/file-max`, `/proc/sys/fs/nr_open`, `/proc/sys/fs/file-nr`, `systemctl show -p DefaultLimitNOFILE`, `kernel.io_uring_disabled`; an `os.open` loop under `setrlimit` (64 and 1024); and a python `sqlite3` probe opening 20 writers and 20 readers. Deno per-connection counts come from the kb entry and were re-checked by the Python probe.

Sources: man7.org (dup(2), close_range(2), open(2), accept(2), pipe(2), eventfd(2), timerfd_create(2), pidfd_open(2), pidfd_send_signal(2), io_uring_register(2), io_uring_setup(2), unix(7), recvmsg(2), proc(5)); docs.kernel.org admin-guide sysctl; go.dev/doc/go1.19; pkg.go.dev/database/sql; pkg.go.dev/os; go.googlesource.com runtime/netpoll.go; sqlite.org (wal, howtocorrupt, vfs, limits, rescode, pragma); postgresql.org runtime-config-resource and runtime-config-connection; pgbouncer.org/features; duckdb.org concurrency and attach; github.com/superfly/litefs; turso.tech blog; docs.libuv.org filesystem; docs.sqlalchemy.org pooling; docs.diesel.rs r2d2 builder; HikariCP README (mirror).

Not fetched or failed: signalfd(2), kernel.org af_unix networking doc (404), rqlite DESIGN.md (404), ARCHITECTURE.md for LiteFS.
