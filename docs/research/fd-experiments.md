# Fd experiments for per-tenant SQLite

Status: proposal, 2026-10-12. Docs only. Nothing here changes `platform/`, `core/`, `sdk/`, `tests/`, `scripts/`,
`perf/` or `deno.json`. Every new script named below goes in `work-scripts/` and gets an `INDEX.md` row when
it is written.

Input: [`fd-landscape.md`](fd-landscape.md) (Luna, research/luna-fd-landscape, 29ba91e). That doc says what the
limits are. This doc says what to run to find out how ts-db behaves near them, and what each result would
decide.

## 0. What the code does today

Facts read from `main` at e808983. The experiments are built around them.

| Path | Where | Behaviour | Fds |
|---|---|---|---|
| Tenant writer cache | `platform/sqlite.ts` `makeStorage`, around line 648 | One `DatabaseSync` per tenant, WAL, `synchronous=FULL`, `busy_timeout=5000`. Capacity **64**, idle expiry **60 s**. The server passes no cache options (`platform/layers.ts:215`), so these defaults are production values and no env var changes them. | 3 per open writer, so **192** at capacity |
| Eviction | same | When full, evicts the least recently released entry with zero leases. If every entry is leased, the request waits for a release. A sweep fiber runs every `idleMs` and closes entries idle for at least `idleMs`, so the real idle expiry falls between 60 s and 120 s. | |
| Open and close under one lock | same, `lock = makeSemaphore(1)` | The cache's single permit is held across the **eviction close**, `router.prepare`, the open, and `makeSingleStorage`'s startup. That startup runs the PRAGMAs and then a `BEGIN IMMEDIATE` transaction with the schema fingerprint check and DDL. Cache hits need the same permit to take a lease. | |
| Document reads | `platform/document_reader.ts` `querySqlite` | A fresh read-only `DatabaseSync` per call, closed after the call. At most **32** run at once (`DOCUMENT_READ_CONCURRENCY_CAP`). | 2 per call, so **64** at the cap |
| DuckDB reader | `platform/reader.ts`, `platform/duckdb.ts` | A separate child process. It never loads `node:sqlite`. It holds one reader per app (`ATTACH … READ_ONLY`), not per tenant. | in the child's own fd table |

So the server's sqlite fds peak near `3 × 64 + 2 × 32 = 256`, plus a fixed overhead that nobody has measured
yet. At 1000s of tenants, two things decide behaviour: how often the cache reopens a writer, and what one
reopen costs everyone else while the lock is held. Most experiments below measure those two.

The cache's idle expiry (60 s) is the same as the landscape doc's "60-second writer" hazard (§5.1). A tenant
that writes once a minute may be evicted between writes and reopen every time. E4 tests this.

## 1. Harnesses to reuse

| Existing piece | Reuse |
|---|---|
| `tests/unit/tenant_routing_test.ts` `harness()` | It builds `makeStorage` with a real router over a temp directory, `ConfigTest({ tenancy: { mode } })`, a stub `EventSink` and `IdGen`, and an open-counting router wrapper. It needs no Postgres and no HTTP. **E1, E4, E5, E6 and E7 copy this pattern** into one work-script driver instead of starting a server. |
| `work-scripts/bash/k6-scenario-run.sh` | It starts a throwaway server (free port, scratch `DATA_DIR`, `setsid` group) and runs one `perf:*` task. **E2 and E8 extend it**: an optional `NOFILE=<n>` runs the server under `prlimit --nofile=<n>`, and an optional `FD_SAMPLE_MS=<ms>` runs the fd census below against the server pid while k6 runs. |
| `work-scripts/bash/k6-baseline.sh` | Its repeat-and-summarise loop and its host-load guard (warn when load exceeds the CPU count) carry over to E5's grid. |
| `work-scripts/bash/segfault-stress.sh` | The pattern to copy: N runs, at most 3 at once, exit code and pid per run, and a dmesg check on signal exits. E2's "does the process survive EMFILE" loop needs exactly this. |
| `work-scripts/deno/sq-02-append-bench.ts` | Its timing and report layout (warm-up, then fixed iterations, then a table) is the model for E4's open and close microbenchmarks. |
| `tests/e2e/platform/` and `docker-compose.yml` (Postgres 17) | The only full tenancy stack with a real registry. Used only by E8, the end-to-end confirmation. |

New shared pieces, built once in E0 and used by everything after:

- `work-scripts/bash/fd-census.sh <pid> [interval_ms] [out.tsv]`: classifies `/proc/<pid>/fd` symlink
  targets into `db`, `wal`, `shm`, `journal`, `socket`, `pipe`, `anon_inode`, `duckdb`, `log` and `other`. It
  prints one TSV row per sample, and the soft and hard `Max open files` from `/proc/<pid>/limits`. Run with
  `--children`, it also samples the reader child (found through `/proc/<pid>/task/*/children`).
- `work-scripts/deno/fd-lib.ts`: in-process helpers for the Deno drivers. `fdCount()` reads
  `Deno.readDirSync("/proc/self/fd")`, `fdByKind()` does the census classification, `nofile()` parses
  `/proc/self/limits`, and `tenantHarness(opts)` holds the copied `makeStorage` setup.

## 2. Experiments

Each experiment lists its question, what we expect, how to run it, what to record, and what each result
decides. Unless marked otherwise, every run finishes in minutes on vm-1. Model tier follows AGENTS.md: luna or
haiku for the mechanical runs, sol or sonnet for the Deno drivers. E6 and E7 touch concurrency and correctness
and need an Opus-tier read of the results.

### E0. Fd census and limit report (foundation)

- **Question.** What does the server process hold at rest, and what limit does it actually run under?
- **Build.** Write `fd-census.sh` and `fd-lib.ts` as described in §1. Also write
  `work-scripts/bash/fd-limits-report.sh <pid|unit>`. It prints `/proc/<pid>/limits`,
  `systemctl show -p LimitNOFILE,LimitNOFILESoft <unit>`, `fs.nr_open`, `fs.file-nr`, the cgroup path and
  `kernel.io_uring_disabled`. This is the runbook for open question 1 in the landscape doc (the production
  limit), so whoever has production access can run it unchanged.
- **Run.** Start `k6-scenario-run.sh perf:smoke` with `FD_SAMPLE_MS=200 KEEP_SCRATCH=1`, and run the census
  against the server and the reader child.
- **Record.** Fds by kind at idle, at peak and after k6 stops, for both processes.
- **Decides.** The `reserved` term of the budget formula: everything that is not a tenant `db`, `wal` or `shm`
  fd. It also gives E2 and E8 their baseline.

### E1. Per-connection fd cost inside ts-db's own code paths

The landscape doc measured 3 fds per writer and 2 per reader with bare `DatabaseSync` and with Python. Our
paths add details those probes did not cover.

- **Question.** What do `makeSingleStorage` writers and `querySqlite` readers hold, in each state the cache
  can be in?
- **Cases.** Each case uses one tenant file and a census after every step.
  1. The writer is open and idle.
  2. The writer is open and a document read runs on the same file (expected: 3 + 2).
  3. The writer was evicted (last close) and a document read runs on the cold file. Does the read-only open
     succeed with no `-wal` or `-shm` present? Does it create them? How many fds does it hold?
  4. The writer was evicted while a document read was still open, so the reader is the last connection. Do
     `-wal` and `-shm` remain on disk afterwards? A read-only connection cannot checkpoint.
  5. A writer reopens after case 4. Census again, and confirm no committed row is lost.
- **Driver.** `work-scripts/deno/fd-e1-states.ts`, built on `tenantHarness` with `capacity: 1` so eviction
  can be forced by touching a second tenant.
- **Decides.** The real per-path constants for the formula. Cases 3 and 4 also decide whether evicting a
  writer while readers are open leaves WAL files behind and costs extra fds on the next read. If it does,
  eviction should skip tenants that have a document read in flight.

### E2. Behaviour at the limit (EMFILE) in Deno, in-process and in the server

The landscape doc saw EMFILE surface as `SQLITE_CANTOPEN`, but only from Python (open question 3). The
process-level failure modes are unknown.

- **E2a, in-process.** Run `prlimit --nofile=128 deno run -A work-scripts/deno/fd-e2-emfile.ts`. The driver
  builds `tenantHarness({ capacity: 200 })` and touches tenants until an open fails. Record:
  - the `StorageError` detail and the squashed cause, including the `node:sqlite` error code and message;
  - whether the failed open left a partly opened handle (fd count before and after the failure);
  - whether the cache recovers. After releasing 10 tenants by forcing idle expiry, the next open should
    succeed.
- **E2b, server.** Run `NOFILE=96 k6-scenario-run.sh perf:mixed` with the census on, with `NOFILE` stepped
  down until failures start. Record:
  - **Accept loop.** Does `Deno.serve` survive EMFILE from `accept()`? Watch for a busy loop (CPU), a crash,
    or connections that are dropped but recover.
  - **Log sink.** It rotates hourly by pid. Does a rotation that hits EMFILE lose records, report the
    failure, or crash?
  - **Reader child.** Does it spawn when the parent is short of fds (pipes), and how does the supervisor
    react if not?
  - **Errors.** The HTTP status and error tag that clients see.
- **Repeat.** Ten runs per `NOFILE` value with the `segfault-stress.sh` pattern, recording exit codes and
  dmesg on signal exits.
- **Decides.** Whether fd exhaustion is a clean, retryable 503 or a process-level outage. If `accept()` or the
  log sink fail badly, the formula's `reserved` term needs a hard floor, and the cache cap should be derived
  from the soft limit at startup rather than fixed at 64.

### E3. Does Deno raise its own soft limit?

This is open question 2 in the landscape doc. It decides which number production runs under.

- **Run.** `prlimit --nofile=1024:65536 deno run -A -e 'console.log(Deno.readTextFileSync("/proc/self/limits"))'`.
  Repeat with `deno task serve`, reading `/proc/<pid>/limits` from outside. Then repeat under a transient
  systemd unit: `systemd-run --user -p LimitNOFILE=1024:65536 …`, or `--scope` as root.
- **Record.** The soft limit seen in each case. One line per case.
- **Decides.** If Deno raises soft to hard, production's effective limit is the hard limit. Ops should then
  set `LimitNOFILE` hard, and the startup budget check (E8) reads the soft limit after Deno's raise. If Deno
  does not raise it, the server should raise it itself (proposal only, no code here).

### E4. Reopen cost, and the 60-second writer

- **Question.** What does one cache miss cost, broken into parts, and how does eviction interact with
  periodic writers?
- **E4a, microbenchmark** (`work-scripts/deno/fd-e4-reopen.ts`, `sq-02` layout). For each tenant shape (db
  1 MB / 100 MB; WAL 0 / 1 MB / 16 MB / 64 MB before close), time each part separately over 50 iterations
  after a warm-up:
  1. close: last-close checkpoint plus unlink of `-wal` and `-shm`;
  2. `new DatabaseSync`;
  3. the three PRAGMAs;
  4. the startup `BEGIN IMMEDIATE` with the fingerprint check and DDL;
  5. the first mutation on a cold page cache, compared with a warm one.

  Use `synchronous=FULL` as in production. Run once on vm-1's disk and once on tmpfs, so storage cost and
  CPU cost can be told apart.
- **E4b, interval against expiry, with scaled time.** `idleMs` is an ordinary option and the sweep uses the
  Effect clock, so scale everything down. Set `idleMs = 100 ms`, run 50 tenants each writing every
  `T ∈ {50, 90, 110, 150, 250} ms` with ±10% jitter, for 30 s. Record reopens per tenant per minute and
  mutation latency p50, p99 and max. Expect a step at `T ≈ idleMs` and a second one near `2 × idleMs`,
  because of how the sweep is scheduled.
- **Decides.** Whether 60 s is safe for our write patterns, and the cost of one miss in milliseconds. If E4a
  shows the close checkpoint dominating, eviction should close outside the lock (E6). If E4b shows the
  `T ≈ idleMs` cliff, the expiry default should rise to several minutes, as the landscape doc §5.1 suggests.
  If the step lands at `2 × idleMs` rather than `idleMs`, the documented expiry is wrong by up to 2×.

### E5. Capacity against working set (the core sizing grid)

- **Question.** For 1k to 10k tenant files with skewed traffic, which cache capacity keeps the miss rate and
  tail latency acceptable within a given fd budget?
- **Driver.** `work-scripts/deno/fd-e5-grid.ts`, using `tenantHarness` and the open counter from the unit
  test.
- **Setup.** Pre-create N tenant files with a small seeded dataset. Generate a seeded Zipf access stream
  (s ∈ {0.8, 1.1}, as fast-check `SEED` arbitraries for reproducibility), 90% mutations and 10% snapshots,
  at fixed concurrency 32.
- **Grid.** N ∈ {1000, 5000, 10000} × capacity ∈ {64, 256, 1024, 4096} × s, with 3 repeats each, under the
  `k6-baseline.sh` load guard.
- **Record.** Hit rate, reopens per second, p50/p99/max latency, time spent waiting for a lease, peak fd count
  from `fdCount()`, and the time spent choosing a victim. The victim search is a linear scan of all entries
  under the lock, so it grows with capacity.
- **Output.** A TSV, plus a short findings file with the knee of the hit-rate curve for each N and s.
- **Decides.** A capacity default, and whether to derive it from the limit, e.g.
  `capacity = floor((soft − reserved − 2 × 32) / 3)`. It also decides whether the linear scan matters at
  thousands of entries. If it does, replace it with an ordered map; that would be a plan item, not done here.

### E6. Head-of-line blocking from the global cache lock

This is the most likely real-world pain, given §0: one tenant's cold open holds the only permit.

- **Question.** How much latency does a stream of cold misses add to hot tenants that are already cached?
- **Setup.** `tenantHarness({ capacity: 64 })`. Eight hot tenants issue mutations in a tight loop and are
  never evicted. A miss generator touches distinct cold tenants at λ ∈ {0, 10, 50, 200} per second. Run with
  a fast cold open (small db, empty WAL) and a slow one (E4a's worst shape: an evicted victim with a 64 MB
  WAL, so the eviction close has to checkpoint).
- **Record.** Hot-tenant lease-acquire time and end-to-end latency (p50, p99, max), against λ.
- **Hypothesis.** Hot p99 grows roughly as λ × (open + eviction close), because the lock serialises both.
- **Variant, scratch copy only.** Copy `makeStorage` into `work-scripts/deno/fd-e6-cache-variant.ts` and
  change it two ways:
  1. drop the victim from the map under the lock, then close it after releasing the lock;
  2. open under a per-tenant single-flight (a `Deferred` per tenant id) instead of the global permit, keeping
     the capacity check atomic with a counter.

  Run the same grid against the variant and compare.
- **Decides.** Whether the cache needs that restructure, which would be a plan item for an Opus builder
  because it changes resource lifetimes. This experiment only produces the evidence.
- **Correctness bar for the variant.** Rerun the three tenant-cache tests from `tenant_routing_test.ts`
  against the variant. Under bounded eviction no write may be lost, and no leased handle may be closed.

### E7. Cheaper writers: fewer fds per open tenant

Each idea trades fds against concurrency or durability. All are measured on scratch files; none ships from
here.

| Variant | Expected fds when idle | Risk to measure |
|---|---|---|
| `journal_mode=WAL` (today) | 3 | baseline |
| `journal_mode=DELETE` or `TRUNCATE` | 1 at rest, 2 during a write | Readers and the writer block each other; DuckDB's `ATTACH` would need a lock window. Measure with E5's mix plus 32 concurrent document reads. |
| WAL with `PRAGMA locking_mode=EXCLUSIVE`, set before WAL is first used | 2 (no `-shm`; the wal-index is kept in heap) [U] | Per-call document readers in the same process probably get `SQLITE_BUSY`. They would have to read through the writer's connection. Measure whether reads fail. |
| WAL via the `unix-excl` VFS, from a `file:…?vfs=unix-excl` URI | 2 (heap wal-index) [U] | Whether `node:sqlite` accepts URI filenames at all. Whether same-process readers still work. Whether the DuckDB child can still `ATTACH` (expected: no, it is another process). |

- **Driver.** `work-scripts/deno/fd-e7-modes.ts`. Per variant, it records the E1 census, writer throughput
  and document-read success rate with 32 readers, and the DuckDB `ATTACH` result from the child (or from a
  standalone DuckDB script, since a scratch file is enough).
- **Decides.** Whether a one-fd idle writer (DELETE mode) is acceptable for small, mostly idle tenants. That
  would triple the number of resident writers for the same budget. If it is, a two-mode design (WAL only for
  hot tenants) becomes a candidate plan item. The two exclusive variants are expected to fail the
  same-process reader check, and recording that failure is useful in itself: it settles a question that
  otherwise comes back in every design review.

### E8. End-to-end budget check under the real stack

- **Question.** Does the full server, in tenancy mode with the Postgres registry, stay within
  `3 × capacity + 2 × 32 + reserved` under multi-tenant load, and fail cleanly just below it?
- **Setup.** Bring up `docker compose up postgres` and run the server in tenancy mode. Write a new k6
  scenario in `work-scripts/` (not in `perf/`) that spreads requests over 2000 tenants with keys from the e2e
  seed helpers.
- **Run.** Use the extended `k6-scenario-run.sh` with `FD_SAMPLE_MS=100`, then repeat with
  `NOFILE = formula + 16` and `NOFILE = formula − 16`.
- **Record.** The census peak compared with the formula; the error rate and error tags in both runs.
- **Decides.** That the formula is correct, or how far off it is. This becomes the acceptance test for any
  later "derive capacity from the limit" item.

## 3. Ordering and cost

| Wave | Experiments | Why this order | Rough cost |
|---|---|---|---|
| 1 | E0, E3 | E0 is the census every other experiment uses; E3 is a one-liner | ≤ 1 hour, luna/haiku |
| 2 | E1, E2a, E4a | Constants, failure modes and per-miss cost; all in-process, no server | half a day, sol/sonnet drivers |
| 3 | E4b, E5, E6 | The sizing and latency questions, which need wave 2's numbers to read | one day; E6's variant needs an Opus review of the results |
| 4 | E2b, E7, E8 | Server- and stack-level checks and alternative modes | one day; E8 needs Postgres |

Waves 2 to 4 have disjoint script sets, so the experiments within a wave can run as parallel subagents. Use
the side-quest protocol: add a row each to `docs/haiku-experiments.md`, and write findings to
`docs/haiku-experiments/findings/fd-eN.md`.

## 4. Considered and not proposed

- **Consolidating tenants with `ATTACH`.** Each attached database keeps its own fds, and
  `SQLITE_MAX_ATTACHED` tops out at 125 (landscape doc §4.1). It does not reduce fds.
- **io_uring fixed files and `SCM_RIGHTS` fd passing.** SQLite's unix VFS calls `open(2)` itself, and
  `node:sqlite` cannot accept a prevalidated fd (`platform/tenants/routing.ts` says so). Neither mechanism can
  reach SQLite's descriptors without a custom VFS. Revisit only if the FFI route recorded in the kb
  (`deno-node-sqlite-worker-terminate-and-fd-cost`) is adopted.
- **Web Workers.** They share the process fd table, so they do not change the fd math (landscape doc §6, item 5).
- **Sharding tenants across processes.** Each process gets its own `RLIMIT_NOFILE`, so this does multiply
  the budget. But raising the limit is far cheaper while E3 and E0 show headroom. Propose it only if
  production's hard limit is fixed and low.

## 5. Already-visible design notes (no experiment needed)

These follow from reading the code. They are listed so that the experiments confirm or size them rather than
discover them:

1. The 64 and 60 s defaults are not configurable from server config (`platform/layers.ts:215`).
2. Eviction closes the victim, with its last-close checkpoint, while holding the lock every tenant needs.
3. Every reopen runs a `BEGIN IMMEDIATE` schema transaction, so a miss is a write even when the request is a
   read-only snapshot.
4. Document reads open a new connection per call, so 32 concurrent reads cost 64 extra fds regardless of how
   many writers are cached.
