# Gotchas

Traps that have actually bitten agents on this project. Read before running commands on vm-1; append when you
get bitten.

## sshvm.sh consumes stdin

`~/workspace/goals/claude-code-and-codex-sessions-on-vm-1/hidden_files/bin/sshvm.sh` runs a fingerprint SSH
before the real command, and that first SSH eats local stdin — piping file content through
`sshvm.sh 'cat > remote'` silently writes a **0-byte file**. Deliver content as base64 inside the command
string:

```bash
B64=$(base64 -w0 local-file) && sshvm.sh "echo '$B64' | base64 -d > remote/path"
```

(base64 alphabet is shell-safe in single quotes.) Verify with `wc -c` after.

## Quote heredoc delimiters through sshvm.sh

Always `<<'PYEOF'` (quoted). An unquoted delimiter lets the local/remote bash eat backticks and `$(...)` via
command substitution mid-script.

## Fingerprint every SSH session

Some connections land on a **wrong same-hostname backend** (empty `/root`, no repo). Never use raw SSH for
repo work — always go through `sshvm.sh`, which fingerprints and prints `REPO_OK`.

## Shared checkout: use worktrees

`/root/Software/ts-db` is shared by concurrent agents. Inspect branch/status before acting, and give every
branch its own worktree (convention: `/root/Software/tsdb-work/<slug>`). Never build two branches in one
checkout.

## Pushes can appear flaky

`git push origin main` sometimes fails silently on this VM. Push with an explicit SSH URL or
`git push <url> HEAD:main`, and always verify with `git ls-remote`.

## `claude --model haiku` is Haiku 5.5 — keep it that way

Verified 2026-10-11: the alias resolves to `claude-haiku-5-5`. If it ever drifts to ≤4.5, pin a ≥5.5 model ID
explicitly (`claude --model
claude-haiku-5-5`). Never run Haiku ≤4.5: it drops safety-critical details and
self-rates 5/5 regardless.

## Exit-139 segfault on teardown (pre-existing flake)

Intermittent native crash (`duckdb.node`) after tests print `ok` — roughly 1 in 15 runs of
`tests/property/offsets_test.ts`, also seen mid-suite in `deno task test`. Reproduced on clean main; treated
as a pre-existing DuckDB/Deno teardown flake. Policy: **chase, don't quarantine** — ~25 identical-shape
`tokio-runtime-w` segfaults in dmesg share one stack page offset (one bug site). Reusable stress loop:
`work-scripts/bash/segfault-stress.sh` (adopted from sq-07; until it lands, on `origin/haiku/sq-07`).

## Two SQLite copies in one process must not share a file

Added 2026-10-13 (FFI binding, `item/ffi-binding`). `platform/sqlite_ffi/` loads the system `libsqlite3`
(3.45.1 on vm-1) next to the SQLite bundled inside `node:sqlite`. POSIX advisory locks belong to the process,
not the descriptor, so when one copy closes any descriptor on a database file the kernel drops the locks the
other copy holds on it, and the two copies then corrupt each other silently. While both libraries are loaded
in one process, each database file is opened by exactly one of them. The perf parity test
(`tests/unit/sqlite_ffi_perf_test.ts`) uses two identical files for that reason. The same rule is why the
DuckDB reader is a separate process (plan §0).

## `Deno.dlopen` and FFI `i64`: bigint in, bigint out

Added 2026-10-13. On Deno 2.9.5 an `i64` FFI parameter's type is `bigint` only (a `number` fails `deno check`)
and `i64` results are `number | bigint`. `platform/sqlite_ffi/` binds int32 values through `sqlite3_bind_int`
and reads INTEGER columns through `sqlite3_column_double` (exact for every safe integer), falling back to
`sqlite3_column_int64` only for `readBigInts` or the unsafe-integer error, which keeps bigint allocation off
the point-read path. A dlopen'd library is not a resource for Deno's test sanitizer, so loading it lazily
inside a test is fine.

## The VM is shared and loaded

Sibling agents run concurrently; load averages of 12+ on 4 vCPUs are normal. Perf numbers (k6 p95/p99)
measured on a loaded host can be 2–3× worse than a quiet host — always record load average with a measurement
and re-check gates on a quiet host before treating them as stable.

## Long commands die on relay timeout

Don't run multi-minute commands inline through the guard. Start a tmux session on vm-1, write output to a
file, poll the file. The VM has 8 GB RAM — keep parallel workloads modest.

## `deno fmt --check` must stay green

A repo-wide formatting baseline landed; CI-equivalent discipline applies to every commit including docs. Run
`deno fmt --check` on touched markdown and `deno lint` where relevant before committing.

## Honesty rules for agent reports

Every factual claim cites pasted command output. Unexecuted checks are labeled _not executed_, never passed.
Haiku 5.5's characteristic failure mode is overstatement of secondary claims (misattributed evidence, dropped
table rows, severity inflation) — headline verdicts held, but every review corrected the details. Verify,
don't trust pastes.

## sshvm.sh fingerprint can't distinguish ts-db backends

`sshvm.sh` fingerprints `/root/Software/prototyper/.git`, which exists on BOTH the right and wrong
same-hostname backends — so a "REPO_OK" fingerprint does not prove you are on the ts-db backend. If
consecutive calls show missing worktrees or unfamiliar state, drop a sentinel file
(`touch
/root/Software/ts-db/.<your-name>`) and retry the connection; bail out rather than working on the
wrong backend. (2026-10-11)

## 2026-10-11 — MT-07 tenant reader and preparation boundary

Tenant queries carry a writer-resolved location over private IPC; no path or tenant id is copied from HTTP
arguments. Do not import `platform/tenants/routing.ts` in the reader: it loads `node:sqlite` and would violate
the two-native-libraries process boundary. The pure UUID parser lives in `registry.ts`. Tenant readers are
scoped to one query for now; a bounded, leased tenant reader pool is a performance follow-up, not a reason to
fall back to the legacy app file.

Writer initialization and query preparation must share the same successful-preparation barrier. Calling
`router.prepare` again on every query takes `BEGIN IMMEDIATE` on a second connection and can block the writer
event loop while a yielding mutation holds a transaction. Regression coverage:
`tests/unit/tenant_auth_test.ts` holds a mutation open while an authenticated query completes.

The required one-file-per-tenant layout means a tenant file has one schema/storage fingerprint. The default
columns and JSON sample apps are alternative layouts: using the other layout on an already-initialized tenant
fails closed on schema mismatch. Supporting incompatible app schemas for one tenant requires an explicit
storage-model decision; do not silently create per-app tenant files.

The key cache stores hashes only, including negative results, with a fixed (non-sliding) deadline. Admin
mutations and authentication must use the same cached registry instance for immediate local invalidation.
Another server instance observes revocation/deactivation within one TTL; there is no cross-instance
invalidation protocol.

MT-07 consumes `Config.tenancy.tenantKeyCacheTtlMs` with the specified 30000 ms default. This base lacks
MT-02's promised `TENANT_KEY_CACHE_TTL_MS` decoder; adding that option, its README row and config tests
remains a configuration-owner follow-up. Do not claim the environment variable is honored until that follow-up
lands. The injected Config field already controls the cache and rejects invalid limits.

## 2026-10-11 — MT-10 tenant fixtures and live analysis

The platform E2E suite must allocate different tenants for the column and JSON sample apps: they are
incompatible layouts of the same tables, and the one-file-per-tenant schema guard intentionally rejects
switching layouts. Better Auth cases also use a fresh server per layout to keep their login workload within
the shared per-path rate limit; credential failures still assert 401.

The reader's analysis RPC must execute the existing catalog, not the pre-item-23 placeholder. Ingest and
analysis use separate connections from the same `DuckDBInstanceCache` in `platform/reader_layers.ts`, with
matching open options. Independent native instances can give analysis stale state after a later ingest;
`tests/unit/reader_ingest_test.ts` covers ingest → analysis → another ingest → analysis. The standalone logs
CLI still opens read-only. The writer process must not import the catalog or DuckDB.
