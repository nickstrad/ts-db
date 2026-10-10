# Haiku experiments and side quests

Purpose: this is the log for experimenting with Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) —
fast and cheap — on real
items from [`docs/plans/effect-port-and-observability.md`](plans/effect-port-and-observability.md),
plus a running side-quest board for small investigative tasks that produce useful findings while
the longer plan items (01-27, coordinated separately) are in flight.

This file is docs-only. Nothing here touches plan item files, the `item/NN-slug` worktrees under
`/root/Software/tsdb-work/`, or `agent-work/` (the coordinator's own scratch space).

---

## Experiment items

**All experiment work is executed by Haiku (`claude --model haiku`).** Nothing here is done by
Sonnet or Opus -- the "Plan baseline" column below shows the model the plan originally assigned to
each item, purely as the comparison baseline for judging Haiku's output.

Picked from items 12-27 (items 01-11 are already in flight on the coordinator's branches and are
off limits). Selection criteria: small, bounded, mechanical, minimal cross-file dependencies,
verifiable acceptance criteria — and preferably an item the plan itself already assigns to
Sonnet, since that is the nearest existing baseline to compare Haiku against.

| ID | Item | Title | Plan baseline | Status | Rationale |
| --- | --- | --- | --- | --- | --- |
| haiku-12 | 12 | Property tests, wave 1: schema, rules, framing, rotation | Sonnet | reviewed, FAIL — not merged — [findings](findings/haiku-12.md) | Pure modules with signatures already fixed by earlier items; the plan itself enumerates the exact properties to encode, so this is "transcribe a spec into fast-check arbitraries," not design work. |
| haiku-14 | 14 | k6 load scenarios and output capture | Sonnet | reviewed, FAIL — not merged — [findings](findings/haiku-14.md) | Three scripts that repeat the pattern item 03 already established (shared `perf/lib/api.js`, fixed thresholds, fixed output paths). Mechanical, low file count, pass/fail is a `k6 run` exit code. |
| haiku-24 | 24 | Retention sweeper | Sonnet | reviewed, NITS after wrapper repair — not merged — [findings](findings/haiku-24.md) | Executes a policy that is already pure and property-tested (items 06, 12); this item is only "apply the plan to the filesystem" with explicit safety rails spelled out in the plan. Small file set, no SQL/transaction semantics to get subtly wrong. |

Rules for every experiment item:

- Haiku works on a branch named `haiku/NN-slug` (e.g. `haiku/12-property-tests-wave-1`), in its own
  git worktree — never inside an `item/NN-slug` worktree and never on `main`.
- Haiku **never merges to `main`** without an Opus review (`reviewer-opus-high`, same acceptance
  criteria the plan item defines) **and** explicit human approval. A PASS verdict alone does not
  authorize a merge.
- When an experiment item finishes (merged, rejected, or abandoned), the branch stays until the
  human says it can be deleted.
- Each experiment item writes its findings to `docs/haiku-experiments/findings/haiku-NN.md` (see
  [Findings](#findings) below) and fills in the [scorecard](#haiku-quality-scorecard) template.

---

## Side quests

Small, read-only or scratch-only investigations — each sized to finish in one short session. A
side quest must **never modify plan item files** (anything under `core/`, `platform/`, `sdk/`,
`app/`, `tests/`, `scripts/`, `perf/`, or `deno.json`). Output is a written finding, not a code
change to the product tree.

| ID | Question | Why it matters | Done-criteria |
| --- | --- | --- | --- |
| sq-01 | What batching/backpressure patterns do Effect-TS `Logger`/sink implementations use in practice, and which ones fit a `Queue.dropping` + `forkScoped` consumer like item 11 describes? | Item 11 (Opus, logger service) is one of the highest-risk items in the plan — getting backpressure or finalizer ordering wrong loses events or hangs shutdown. A short survey de-risks that item before it's built. | A written summary of 2-3 concrete patterns (with their tradeoffs) from Effect-TS docs/source/community examples, and an explicit recommendation for which one fits this repo's constraints (bounded queue, batch by size-or-time, flush-on-shutdown). No code written. |
| sq-02 | What is the baseline JSONL append throughput (events/sec, and MB/sec) on this droplet, using plain `Deno.FsFile` append-mode writes with no batching? | Item 11's acceptance criteria requires "10,000 events in under 2s" as a sanity check. Knowing the raw floor ahead of time tells us how much headroom the real batching design needs, and whether the 2s bar is trivial or tight on this hardware. | A short scratch script (not committed to the product tree — lives under `docs/haiku-experiments/scratch/` or is run and discarded) measuring append throughput at a few record sizes, with numbers recorded in the finding. |
| sq-03 | Which fast-check arbitrary-construction strategies (recursive, `fc.letrec`, sized, shrink-friendly) best fit generating `Node`/`Fields`/`Table` values for the schema module ahead of item 12? | Item 12 depends on `tests/property/arbitraries.ts`, which has to generate recursive schema nodes (arrays nesting to depth 2) that also shrink to minimal counterexamples. Picking the wrong strategy up front costs rework once item 12 starts. | A short writeup naming the recommended fast-check APIs for this shape of data, with a tiny (uncommitted) code sketch demonstrating depth-bounded recursive generation and a note on how well it shrinks. |
| sq-04 | What k6 output format (`--out json=`, `--out csv=`, experimental `--out influxdb=`, etc.) is most convenient for later DuckDB ingestion via `read_json_auto`, and are there any gotchas (one object per metric point vs. one summary object, nested tag objects) that would complicate item 25's `perf/ingest_k6.ts`? | Items 03, 14 and 25 all depend on k6's raw output shape. A quick comparison now avoids finding out the hard way during item 25 that the JSON isn't flat enough for `read_json_auto`. | A short comparison table of 2-3 output formats against "ease of DuckDB ingestion," with a concrete recommendation and an example of the exact JSON shape k6 emits per metric point. |

| ID | Status |
| --- | --- |
| sq-01 | done — [findings](findings/sq-01.md) |
| sq-02 | done — [findings](findings/sq-02.md) |
| sq-03 | done — [findings](findings/sq-03.md) |
| sq-04 | done — [findings](findings/sq-04.md) |

The main agent (not Haiku) appends new side quests here as they come up; Haiku subagents claim one,
investigate, and report back — they do not add new quests to this board themselves.

#### Script convention for Haiku agents

If your quest or item needs a script (benchmark, probe, measurement): write it in **Deno** for
larger work, **bash** if it is bash-oriented — and save it in `work-scripts/` (`deno/` or
`bash/`), collocated with all other work scripts, not in a haiku-only folder. Then append a row
to `work-scripts/INDEX.md`. Read the index first: the building block you need may already exist.

## Findings usefulness (Opus review, 2026-10-10)

One line per quest: did it produce an actionable insight, and for which plan item?

- **sq-01 — useful (item 11).** Actionable: names three concrete batching patterns and recommends
  Pattern 2 (size threshold + timer escape hatch) over `Stream.groupedWithin`, with the right
  reason — `groupedWithin` cannot guarantee item 11's hard 256-record threshold. Caveat: cites an
  Effect 4.0.0 `groupedWithin` optimisation, but this repo pins `effect@3.22.2`, so that specific
  claim does not apply here; the recommendation stands regardless since it argues *against*
  `groupedWithin`.
- **sq-02 — useful (item 11).** Actionable and backed by real measurements on this droplet: the
  unbatched `Deno.FsFile` append floor is 7.6k–13.2k events/sec, so item 11's "10,000 events under
  2s" bar is not tight and the batching design can be judged on shutdown/backpressure correctness
  rather than throughput. Caveat: the numbers are non-monotonic in record size (1 KB measures
  *slower* than 4 KB), so treat them as an order-of-magnitude floor, not a calibrated benchmark.
- **sq-03 — useful (item 12), and item 12 ignored it.** Actionable: recommends depth-parameterised
  sized arbitraries over `fc.letrec` for recursive `Node` generation, with a working sketch. Worth
  noting against the experiment's own result — `haiku/12-props` used a flat `fc.oneof` instead, and
  its generators turned out to be the root cause of two vacuous properties (see
  [haiku-12](findings/haiku-12.md)). The advice was sound and unheeded.
- **sq-04 — useful (items 14, 25).** Actionable: captures the real per-point JSON shape k6 emits
  (`{metric, type:"Point", data:{time, value, tags:{...}}}`) plus the `type:"Metric"` definition
  lines that must be filtered with `WHERE type = 'Point'` — exactly the gotcha item 25's
  `read_json_auto` ingest would otherwise hit. Two caveats: it reports testing k6 v0.52.0 while
  this droplet has v0.56.0 installed, and its headline recommendation (CSV) conflicts with the
  plan's mandated `--out json=` for items 14/25 — read it for the JSON shape and the filter
  requirement, not for the format choice.

---

### Script convention for Haiku agents

If your quest or item needs a script (benchmark, probe, measurement): write it in **Deno** for
larger work, **bash** if it is bash-oriented — and save it in `work-scripts/` (`deno/` or
`bash/`), collocated with all other work scripts, not in a haiku-only folder. Then append a row
to `work-scripts/INDEX.md`. Read the index first: the building block you need may already exist.

## Findings

Convention: every completed quest or experiment item writes exactly one findings file at
`docs/haiku-experiments/findings/<quest-id>.md` (e.g. `findings/sq-01.md`, `findings/haiku-12.md`).
That path is unique per quest/item — a Haiku agent only ever writes its own findings file, never a
shared file, so concurrent Haiku runs can't collide on an edit.

- Haiku agents: investigate, then write (only) `docs/haiku-experiments/findings/<id>.md`. Do not
  edit this board, `MEMORY.md`, or any other quest's findings file.
- The main agent: after a quest/item finishes, updates its `Status` in the tables above to link the
  findings file, and commits both the status change and the new findings file together.

---

## Haiku quality scorecard

Fill in after each experiment item (not side quests — those are judged on the finding's usefulness,
not code quality).

### haiku-12 — filled in by Opus, 2026-10-10

```
Item: haiku-12 (plan item 12 — property tests wave 1)
Branch: haiku/12-props (b1a1a26)
Date: 2026-10-10

Correctness:         [ ] matches acceptance criteria   [ ] partial   [X] fails
Test discipline:     [ ] wrote/extended required tests  [X] missing coverage
Owns-scope adherence:[ ] touched only its Owns set
                     [X] strayed into: core/errors.ts, core/schema.ts, core/ipc/framing.ts,
                         core/logging/rotation.ts, app/rules.ts (sanctioned temporary scaffolds,
                         all clearly marked), plus deno.json / deno.lock / package.json
                         (item 01 — unsanctioned, now collides with landed main)
Review verdict:      [ ] PASS   [ ] NITS   [X] FAIL   (Opus review)
Merged to main:      [ ] yes (human-approved)   [X] no

Sonnet-to-Haiku conversion verdict:
[ ] Haiku output is indistinguishable from what Sonnet would have produced --
    this item class can move to Haiku going forward.
[ ] Haiku output is usable but needed meaningful correction -- Haiku viable for
    this item class only with Opus review in the loop.
[X] Haiku output not acceptable for this item class -- keep on Sonnet/Opus.

Reasoning (one line): all 23 properties pass in 1s, but the two that guard "never delete today's
logs" are provably vacuous and the commit message claims a mutation check that does not reproduce.

Notes:
- Verified: `deno test -A tests/property/` -> ok | 4 passed (23 steps) | 0 failed (1s). Seed 42
  printed in every suite name. Under the 60s budget.
- NOT verified / contradicted: the plan's named mutation criterion. Breaking the today-guard at
  core/logging/rotation.ts:113 AND at :147 both leave the suite green, exit 0.
- Root cause: invariant 1 injects a today-file but runs under DEFAULT_POLICY (2 GiB) so the
  maxTotalBytes branch is unreachable; invariant 4 can trigger pruning but its today-file list is
  always empty (measured: 0 today-files in 5000 runs, while pruning fired in 3091). The two
  blind spots cover for each other.
- Commit message false claims: "each property runs 200+ iterations" (only 4 of 23 use numRuns 200;
  rotation uses 50 throughout) and "mutation check verified ... caught the breakage".
- arbitraries.ts calls fc.sample() at 6 sites while building arbitraries, which draws outside the
  seeded source -- `nullable` and `length` are neither reproducible from seed 42 nor shrinkable.
- Credit where due: all five scaffolds carry an explicit "TEMPORARY SCAFFOLD ... Do not build on
  this" header naming their owning item.
```

### haiku-14 — filled in by Opus, 2026-10-10

```
Item: haiku-14 (plan item 14 — k6 load scenarios and output capture)
Branch: haiku/14-k6 (7cddbc4)
Date: 2026-10-10

Correctness:         [ ] matches acceptance criteria   [ ] partial   [X] fails
Test discipline:     [ ] wrote/extended required tests  [X] missing coverage
                     (nothing on this branch was executed before commit)
Owns-scope adherence:[ ] touched only its Owns set
                     [X] strayed into: perf/lib/api.js (ITEM 03 OWNS -- see collision note),
                         perf/README.md (item 03 owns the file; item 14 owns only its scenario
                         section, but Haiku authored all 102 lines)
Review verdict:      [ ] PASS   [ ] NITS   [X] FAIL   (Opus review)
Merged to main:      [ ] yes (human-approved)   [X] no

Sonnet-to-Haiku conversion verdict:
[ ] Haiku output is indistinguishable from what Sonnet would have produced --
    this item class can move to Haiku going forward.
[ ] Haiku output is usable but needed meaningful correction -- Haiku viable for
    this item class only with Opus review in the loop.
[X] Haiku output not acceptable for this item class -- keep on Sonnet/Opus.

Reasoning (one line): two of the three scripts fail to load in k6 at all, and the custom metric,
load model and output capture that constitute the item are absent or dead code.

Notes:
- Verified with k6 v0.56.0 via `k6 archive` (parses script + modules + thresholds, no server
  needed): mutation_load.js exit 0; query_load.js and mixed.js BOTH exit 104 --
  `failed parsing threshold expression's "< 0.01" left hand side`. `http_req_failed: ["< 0.01"]`
  needs the aggregation method: `["rate < 0.01"]`. One-word fix; one run would have caught it.
- query_load.js uses `stages: [{duration:"2m", target:50}]` (50 concurrent VUs) where the plan
  requires `constant-arrival-rate` at 50 rps -- a different load model, and it defeats the
  scenario's only purpose (fixed arrival rate against the serialized single reader).
- No `k6/metrics` import anywhere: the required custom `conflicts` counter does not exist, and
  because api.js uses plain http.post with no responseCallback, expected 409s count in
  http_req_failed -- the opposite of what the plan specifies.
- Output capture is inert: `configureOutput()` is never called (and --out cannot be set from
  inside a script anyway), so logs/k6/<run-id>/raw.json is never written. handleSummary hardcodes
  `passed: true`, so a threshold-failing run still records success.
- Trace-id defect: api.js:9 binds `__ENV.RUN_ID || ""` at import time, which runs BEFORE each
  script's line 8 assigns it -> every request sends `X-Trace-Id: <VU>-<ITER>-` with the run id
  missing, breaking the k6<->platform join item 25 depends on.
- *** COLLISION, must be honoured on any future merge: perf/lib/api.js is owned by ITEM 03 and is
  only a *Read* for item 14. Item 03's api.js MUST win; Haiku's copy MUST be dropped -- it carries
  the trace-id defect above and throws on any status >= 400, which is incompatible with the
  mutation scenario's expected-409 design. Same for perf/README.md: item 03 owns the file, carry
  over only Haiku's scenario section. ***
```

### haiku-24 — filled in by Opus, 2026-10-10

```
Item: haiku-24 (plan item 24 — retention sweeper)
Branch: haiku/24-sweeper (68d0188; Haiku's original is reflog-only at 99a1a0d)
Date: 2026-10-10

Correctness:         [ ] matches acceptance criteria   [X] partial   [ ] fails
                     (as pushed; as Haiku left it, the headline safety rail was absent)
Test discipline:     [X] wrote/extended required tests  [X] missing coverage
                     (real 30-day tree + real dry-run inventory test, but the LOG_DIR safety test
                      asserted nothing; and criterion 2's "emits an error event" is still unasserted)
Owns-scope adherence:[ ] touched only its Owns set
                     [X] strayed into: deno.json (item 01 -- would clobber the landed task table),
                         docs/observability.md (ITEM 23 owns; plan work-item 4 does direct one
                         statement there, but Haiku authored all 38 lines and asserted
                         unimplemented item 21/23 behaviour as fact)
Review verdict:      [ ] PASS   [X] NITS   [ ] FAIL   (Opus review, post-wrapper)
Merged to main:      [ ] yes (human-approved)   [X] no

Sonnet-to-Haiku conversion verdict:
[ ] Haiku output is indistinguishable from what Sonnet would have produced --
    this item class can move to Haiku going forward.
[X] Haiku output is usable but needed meaningful correction -- Haiku viable for
    this item class only with Opus review in the loop.
[ ] Haiku output not acceptable for this item class -- keep on Sonnet/Opus.

Reasoning (one line): competent structure and genuinely specific bulk tests, but Haiku omitted the
one safety rail the plan flags as this item's reason for existing and could not detect the omission.

Notes:
- Verified: `deno test -A tests/unit/retention_test.ts` -> ok | 10 passed | 0 failed (292ms). The
  30-day synthetic tree is real and specific (lifecycle event reports 48 gzipped / 64 deleted by
  exact path, today untouched); the --dry-run test genuinely asserts a before/after inventory.
- ATTRIBUTION: the wrapper's fixes were --amend'ed into Haiku's commit, so the pushed branch shows
  ONE commit and cannot be split from the remote alone. Recovered via reflog: 99a1a0d is Haiku's
  original, 68d0188 the amended tip; `git diff 99a1a0d 68d0188` is exactly the wrapper's work.
  99a1a0d is reflog-only and will be GC'd -- tag it if this needs re-verifying.
- What the wrapper had to add: the ENTIRE LOG_DIR prefix-check rail (isPathWithinDir +
  emitErrorEvent + 4 call sites) -- Haiku had none, despite its commit message claiming "Refuse
  operations outside configured LOG_DIR with error event to stderr".
- What the wrapper had to replace: Haiku's test "sweep: refuses to operate outside configured
  LOG_DIR", which never built an outside path and asserted only `assert.ok(result)` -- it passed
  whatever the code did, occupying the slot the acceptance criterion points at.
- Also wrapper-side: lint/dead-code cleanup (unused imports, unused todayStr, a dead newestPath
  block) and deno fmt reflows.
- Nit: plan(..., openFiles = new Set()) honours an open-file set but runSweepCli passes none, so
  production has no "ask the sink" wiring; defensible (item 06's file_sink hasn't landed) and
  mitigated by the today-dir guard, but there is no TODO naming item 06.
- Best test-discipline signal across all three items: the commit message's explicit "## Assumptions"
  section correctly defers acceptance criterion 4 (.gz ingestibility) to item 21 rather than
  claiming it.
```

### Template (for future items)

```
Item: haiku-NN (plan item NN)
Branch: haiku/NN-slug
Date:

Correctness:        [ ] matches acceptance criteria   [ ] partial   [ ] fails
Test discipline:     [ ] wrote/extended required tests  [ ] missing coverage
Owns-scope adherence:[ ] touched only its Owns set      [ ] strayed into: ___
Review verdict:      [ ] PASS   [ ] NITS   [ ] FAIL   (reviewer-opus-high)
Merged to main:       [ ] yes (human-approved)   [ ] no

Sonnet-to-Haiku conversion verdict:
[ ] Haiku output is indistinguishable from what Sonnet would have produced --
    this item class can move to Haiku going forward.
[ ] Haiku output is usable but needed meaningful correction -- Haiku viable for
    this item class only with Opus review in the loop.
[ ] Haiku output not acceptable for this item class -- keep on Sonnet/Opus.

Notes:
-
```
