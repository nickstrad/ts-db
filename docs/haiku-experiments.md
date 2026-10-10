# Haiku experiments and side quests

Purpose: this is the log for experimenting with Claude Haiku (5.5) — fast and cheap — on real
items from [`docs/plans/effect-port-and-observability.md`](plans/effect-port-and-observability.md),
plus a running side-quest board for small investigative tasks that produce useful findings while
the longer plan items (01-27, coordinated separately) are in flight.

This file is docs-only. Nothing here touches plan item files, the `item/NN-slug` worktrees under
`/root/Software/tsdb-work/`, or `agent-work/` (the coordinator's own scratch space).

---

## Experiment items

Picked from items 12-27 (items 01-11 are already in flight on the coordinator's branches and are
off limits). Selection criteria: small, bounded, mechanical, minimal cross-file dependencies,
verifiable acceptance criteria — and preferably an item the plan itself already assigns to
Sonnet, since that is the nearest existing baseline to compare Haiku against.

| ID | Item | Title | Model (plan) | Status | Rationale |
| --- | --- | --- | --- | --- | --- |
| haiku-12 | 12 | Property tests, wave 1: schema, rules, framing, rotation | Sonnet | proposed | Pure modules with signatures already fixed by earlier items; the plan itself enumerates the exact properties to encode, so this is "transcribe a spec into fast-check arbitraries," not design work. |
| haiku-14 | 14 | k6 load scenarios and output capture | Sonnet | proposed | Three scripts that repeat the pattern item 03 already established (shared `perf/lib/api.js`, fixed thresholds, fixed output paths). Mechanical, low file count, pass/fail is a `k6 run` exit code. |
| haiku-24 | 24 | Retention sweeper | Sonnet | proposed | Executes a policy that is already pure and property-tested (items 06, 12); this item is only "apply the plan to the filesystem" with explicit safety rails spelled out in the plan. Small file set, no SQL/transaction semantics to get subtly wrong. |

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

The main agent (not Haiku) appends new side quests here as they come up; Haiku subagents claim one,
investigate, and report back — they do not add new quests to this board themselves.

---

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

```
Item: haiku-NN (plan item NN)
Branch: haiku/NN-slug
Date:

Correctness:        [ ] matches acceptance criteria   [ ] partial   [ ] fails
Test discipline:     [ ] wrote/extended required tests  [ ] missing coverage
Owns-scope adherence:[ ] touched only its Owns set      [ ] strayed into: ___
Review verdict:      [ ] PASS   [ ] NITS   [ ] FAIL   (reviewer-opus-high)
Merged to main:       [ ] yes (human-approved)   [ ] no

Notes:
-
```
