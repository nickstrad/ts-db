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
