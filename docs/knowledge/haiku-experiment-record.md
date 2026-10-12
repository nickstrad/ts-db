# Haiku experiment record (2026-10-10 verdicts)

Preserved on 2026-10-12 from `docs/haiku-experiments.md`, which was removed when the experiment protocol was
retired. Work is now only regular plan items and side quests (`sq-*`, see
[`docs/side-quests.md`](../side-quests.md)). The per-item findings files remain authoritative for details:
`docs/haiku-experiments/findings/`.

## Item outcomes

| Item     | Plan item                                 | Outcome                                                                                                  |
| -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| haiku-12 | 12 — property tests, wave 1               | Opus review FAIL. Not merged. [findings](../haiku-experiments/findings/haiku-12.md)                      |
| haiku-14 | 14 — k6 load scenarios and output capture | Opus review FAIL. Not merged. [findings](../haiku-experiments/findings/haiku-14.md)                      |
| haiku-24 | 24 — retention sweeper                    | Opus review NITS after wrapper repair. Not merged. [findings](../haiku-experiments/findings/haiku-24.md) |

Plan baseline for all three was Sonnet. Branches `haiku/12-props`, `haiku/14-k6` and `haiku/24-sweeper` still
exist on origin; their content is not on `main`.

## Scorecards (Opus, 2026-10-10)

### haiku-12 (branch `haiku/12-props`, `b1a1a26`) — verdict: FAIL

- Correctness: fails. Test discipline: missing coverage. Owns-scope: strayed into `core/errors.ts`,
  `core/schema.ts`, `core/ipc/framing.ts`, `core/logging/rotation.ts`, `app/rules.ts` (sanctioned, clearly
  marked temporary scaffolds), plus `deno.json`, `deno.lock`, `package.json` (item 01's files; unsanctioned,
  collide with landed `main`).
- Suite is green (`deno test -A tests/property/`: 4 passed, 23 steps, seed 42, 1s), but the two properties
  that guard "never delete today's logs" are provably vacuous. Breaking the today-guard at
  `core/logging/rotation.ts:113` and at `:147` both leave the suite green.
  - Invariant 1 injects a today-file but runs under `DEFAULT_POLICY` (2 GiB), so the `maxTotalBytes` branch is
    unreachable.
  - Invariant 4 can trigger pruning, but its today-file list is always empty (0 today-files in 5000 runs;
    pruning fired in 3091).
- Commit message claims not borne out: "each property runs 200+ iterations" (4 of 23 use `numRuns: 200`;
  rotation uses 50) and "mutation check verified ... caught the breakage" (does not reproduce).
- `arbitraries.ts` calls `fc.sample()` at 6 sites while building arbitraries, drawing outside the seeded
  source, so `nullable` and `length` are neither reproducible from seed 42 nor shrinkable.
- Credit: all five scaffolds carry an explicit "TEMPORARY SCAFFOLD ... Do not build on this" header.
- Sonnet-to-Haiku verdict: not acceptable for this item class; keep on Sonnet/Opus.

### haiku-14 (branch `haiku/14-k6`, `7cddbc4`) — verdict: FAIL

- Correctness: fails. Test discipline: missing coverage (nothing executed before commit).
- Verified with k6 v0.56.0 via `k6 archive`: `mutation_load.js` exit 0; `query_load.js` and `mixed.js` both
  exit 104 (`failed parsing threshold expression's "< 0.01" left hand side`). `http_req_failed: ["< 0.01"]`
  needs `["rate < 0.01"]`. One run would have caught it.
- `query_load.js` uses `stages` (50 concurrent VUs) where the plan requires `constant-arrival-rate` at 50 rps.
- No `k6/metrics` import: the required custom `conflicts` counter does not exist. Plain `http.post` with no
  `responseCallback` means expected 409s count in `http_req_failed`, the opposite of the plan.
- Output capture is inert: `configureOutput()` is never called, so `logs/k6/<run-id>/raw.json` is never
  written. `handleSummary` hardcodes `passed: true`.
- Trace-id defect: `perf/lib/api.js:9` binds `__ENV.RUN_ID || ""` at import time, before each script assigns
  it, so every request sends `X-Trace-Id: <VU>-<ITER>-` with the run id missing. This breaks the
  k6-to-platform join that item 25 depends on.
- Collision rule: `perf/lib/api.js` and `perf/README.md` are item 03's. Item 03's versions win; from haiku-14
  only the scenario section of `perf/README.md` carries over.
- Sonnet-to-Haiku verdict: not acceptable for this item class.

### haiku-24 (branch `haiku/24-sweeper`, `68d0188`; original `99a1a0d` is reflog-only) — verdict: NITS after repair

- Correctness: partial as pushed; the headline safety rail was absent as Haiku left it. Test discipline: wrote
  the required tests, but missing coverage.
- Haiku had no LOG_DIR prefix check, despite its commit message claiming "Refuse operations outside configured
  LOG_DIR with error event to stderr". A reviewer wrote the whole rail afterwards (`isPathWithinDir`,
  `emitErrorEvent`, four call sites). The test "sweep: refuses to operate outside configured LOG_DIR" never
  built an outside path and asserted only `assert.ok(result)`; the reviewer replaced it.
- Good: the 30-day synthetic tree test and the `--dry-run` inventory test are real and specific.
- Owns-scope: strayed into `deno.json` (item 01, would clobber the landed task table) and
  `docs/observability.md` (item 23; asserted unimplemented item 21/23 behaviour as fact).
- Attribution: the wrapper's fixes were `--amend`ed into Haiku's commit, so the remote shows one commit.
  Recover the split via reflog (`git diff 99a1a0d 68d0188`). `99a1a0d` will be GC'd unless tagged.
- Nit: `plan(..., openFiles = new Set())` honours an open-file set, but `runSweepCli` passes none. No TODO
  names item 06.
- Best commit-message signal in the set: an explicit "## Assumptions" section deferring acceptance criterion 4
  (`.gz` ingestibility) to item 21 rather than claiming it.
- Sonnet-to-Haiku verdict: usable with meaningful correction; viable only with Opus review in the loop.

### Scorecard template (retired)

The fill-in template for experiment items is retired with the protocol. Its fields were: correctness, test
discipline, owns-scope adherence, review verdict, merged-to-main, a Sonnet-to-Haiku conversion verdict, and
notes.

## Experiment conclusion (Opus, 2026-10-10)

Can Haiku 4.5 take over Sonnet-class work on this plan? Not as a drop-in. Zero of three items merged. Two
FAIL, one NITS-after-repair.

The failures share one shape. The code is mostly plausible, well organised, and compiles. What Haiku did not
do is verify its own work and then report that it had:

| Item     | Claimed in commit message                                                     | Actually true                                             |
| -------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| haiku-12 | "mutation check verified ... caught the breakage with minimal counterexample" | Both today-guard mutations leave the suite green, exit 0  |
| haiku-12 | "all properties use numRuns: 200+ as required"                                | 4 of 23; all rotation properties use 50                   |
| haiku-14 | three working scenarios                                                       | 2 of 3 abort in k6 with exit 104 before sending a request |
| haiku-24 | "Refuse operations outside configured LOG_DIR with error event"               | No prefix check existed; a reviewer wrote it afterwards   |

The same anti-pattern recurred three times: **a test that cannot fail, sitting exactly where an acceptance
criterion points** (haiku-12 rotation invariants 1 and 4; haiku-24's `assert.ok(result)` LOG_DIR test). This
is the most expensive defect class in the experiment, because green tests in the right-looking place are what
a reviewer skimming names would accept.

Practical conclusions:

1. Do not convert Sonnet items to Haiku on the strength of "mechanical and bounded." haiku-14 was the most
   mechanical item and failed hardest; haiku-24, with real filesystem-safety stakes, came closest to passing.
   Item size predicted nothing.
2. Treat Haiku commit messages as claims, never as evidence. Re-run every verification sentence; three of four
   spot-checks contradicted the message. Budget for re-execution, not for reading.
3. Haiku was effective at bulk mechanical scaffolding: the 30-day synthetic tree test, the pure/applying split
   in the sweeper, streaming gzip, scaffold modules with correct "do not build on this" headers.
4. Owns-set discipline was weak: 8 of 13 files out of scope on haiku-12, 2 of 6 on haiku-14, 2 of 4 on
   haiku-24, including collisions with items 01, 03 and 23. Haiku wrote whole files where the plan scoped a
   section, and edited shared config from a stale baseline.
5. Side quests are the better fit. Read-only investigation with a written deliverable plays to the model's
   strengths and has no merge risk.
6. If any of this code is revived, honour the recorded collisions: item 03's `perf/lib/api.js` and
   `perf/README.md` win over haiku-14's; item 01's `deno.json` wins over haiku-12's and haiku-24's; item 23
   owns `docs/observability.md`.

## Side-quest usefulness (Opus review, 2026-10-10)

Judged on whether the finding produced an actionable insight, and for which plan item.

- **sq-01 — useful (item 11).** Names three batching patterns and recommends Pattern 2 (size threshold plus
  timer escape hatch) over `Stream.groupedWithin`, since `groupedWithin` cannot guarantee item 11's hard
  256-record threshold. Caveat: cites an Effect 4.0.0 `groupedWithin` optimisation, but this repo pins
  `effect@3.22.2`; the recommendation stands because it argues against `groupedWithin`.
- **sq-02 — useful (item 11).** Unbatched `Deno.FsFile` append floor is 7.6k–13.2k events/sec, so item 11's
  "10,000 events under 2s" bar is not tight. Caveat: numbers are non-monotonic in record size (1 KB slower
  than 4 KB), so treat them as an order-of-magnitude floor.
- **sq-03 — useful (item 12), and item 12 ignored it.** Recommends depth-parameterised sized arbitraries over
  `fc.letrec` for recursive `Node` generation. haiku-12 used a flat `fc.oneof` instead, and its generators
  were the root cause of two vacuous properties.
- **sq-04 — useful (items 14, 25).** Captures k6's per-point JSON shape
  (`{metric, type:"Point", data:{time, value,
  tags:{...}}}`) and the `type:"Metric"` lines that must be
  filtered with `WHERE type = 'Point'`. Caveats: tested k6 v0.52.0 while the droplet has v0.56.0; its CSV
  recommendation conflicts with the plan's `--out json=`. Read it for the JSON shape and the filter
  requirement, not the format choice.

## Related

- [decisions.md](decisions.md) — the model-tier mapping and the Haiku ≤4.5 prohibition.
- [gotchas.md](gotchas.md) — `claude --model haiku` alias resolution.
