# Agent orchestration protocol for ts-db

This file is the coordination contract for agents working on this repo. It covers the plan in
[`docs/plans/effect-port-and-observability.md`](docs/plans/effect-port-and-observability.md) and the Haiku
experiment track in [`docs/haiku-experiments.md`](docs/haiku-experiments.md). For repo conventions (how to run
things, style), see `CLAUDE.md`.

## Build protocol (plan items)

1. **Brief**: the coordinator takes one item from the plan (its Owns/Reads sets, model assignment, work steps,
   acceptance criteria) and hands it to a builder subagent.
2. **Build**: the builder works on branch `item/NN-slug`, in its own git worktree (coordinator worktrees live
   under `/root/Software/tsdb-work/` — other agents must not touch those paths or branches while work is in
   flight). The builder edits only files in its item's `Owns` set and may read, but not edit, files in its
   `Reads` set.
3. **Commit**: one item = one commit on that branch. Subject line: `<area>: <imperative summary>`.
4. **Review**: an Opus reviewer (`reviewer-opus-high`) reviews the diff against `main` against the plan item's
   acceptance criteria and returns a verdict: **PASS**, **NITS**, or **FAIL**. Review is not a separate plan
   item — every item gets one regardless of which model built it.
5. **Land**: on PASS, the coordinator merges the branch to `main` and pushes. NITS gets a fixup commit and a
   re-review of the delta; FAIL goes back to the builder with the defect list.

## Batch and concurrency rules

- A **batch** is a set of plan items that may run concurrently: no shared files, no ordering dependency
  between them. Items in the same batch must have disjoint `Owns` sets — a reviewer rejects a diff that edits
  a file outside its item's `Owns` set.
- An item marked **SYNC** must land before the next batch starts. See the plan's §3 batch table for which
  items gate which batches.
- `deno.json` is written once, completely, in item 01. No later item edits it.
- Every commit must leave `deno task ci` green.

## Model assignment policy

- **Opus** (`implementer-opus-high`) — items that decide semantics expensive to get wrong later: SQL
  generation, transaction/concurrency boundaries, resource lifetimes (scopes, child processes, DB handles),
  public type-level API, the error taxonomy.
- **Sonnet** (`implementer-sonnet-high`) — bounded, mechanical items: the interface is already fixed by an
  earlier item, the file list is short, acceptance criteria are checkable by running a command.
- **Haiku 5.5** (never 4.5) — experiments and side quests **only**, tracked in `docs/haiku-experiments.md`.
  Haiku never lands work to `main` without both an Opus review (PASS) and explicit human approval — a PASS
  alone is not sufficient authorization to merge. Haiku work happens on `haiku/NN-slug` branches, never on an
  `item/NN-slug` branch or worktree.

Every item, regardless of model, gets the same Opus review pass described above.

## Model duality

Builders may use `claude --model opus|sonnet|haiku` or `codex exec --model <full-id>`. The short OpenAI names
below are plan labels; pass the full verified ID to Codex. The top Anthropic tier is **Opus 5.5**.

| Repo tier                       | Claude CLI alias                 | OpenAI label | Codex model ID |
| ------------------------------- | -------------------------------- | ------------ | -------------- |
| Top: hard correctness, reviews  | `opus` (Opus 5.5)                | astra        | `gpt-6-astra`  |
| Middle: bounded mechanical work | `sonnet`                         | sol          | `gpt-6.1-sol`  |
| Fast/cheap, run on high effort  | `haiku` (= Haiku 5.5, never 4.5) | luna         | `gpt-6-luna`   |

IDs verified in `/root/.codex/models_cache.json`, fetched 2026-10-11 02:23 UTC (CLI 0.161.0). No OpenAI ID
deviations were found. This is the repo's standing dispatch correspondence.

Match the task's intelligence tier; either family is acceptable within that tier. This section permits astra
where the build protocol or a plan calls for Opus 5.5, including an independent top-tier review (a different
reviewer from the builder), and sol where it calls for Sonnet. Luna is the Haiku 5.5-tier OpenAI label and
always runs on high effort; the `haiku` alias resolves to `claude-haiku-5-5` (verified 2026-10-11 via
`--output-format json`); if the alias ever drifts, pin with `claude --model claude-haiku-5-5`. Haiku 4.5 must
never be used; the Haiku experiment restrictions, including explicit human approval before landing, also apply
to luna when dispatched in the experiment tier. The mapping above is the standing one. Independent reviews
stay top-tier (Opus 5.5 or astra). Model names alone never authorize work outside an item's ownership. This
orchestration policy lives only here; `CLAUDE.md` needs no change.

## Side-quest protocol

Side quests are small, bounded investigations (survey a library's patterns, measure a baseline, compare output
formats) that are read-only or scratch-only against the product tree — they must never modify plan item files
(`core/`, `platform/`, `sdk/`, `app/`, `tests/`, `scripts/`, `perf/`, `deno.json`).

1. The main agent appends new quests to the "Side quests" table in `docs/haiku-experiments.md` (id, question,
   why it matters, done-criteria).
2. A Haiku subagent claims one quest, investigates, and writes its findings to exactly
   `docs/haiku-experiments/findings/<quest-id>.md` — a unique path per quest, so concurrent Haiku runs never
   collide on a shared-file edit. A Haiku agent does not edit the board itself, any other quest's findings
   file, or `MEMORY.md`.
3. The main agent updates the quest's status in the board and commits the status change together with the new
   findings file.

## Work scripts

Reusable scripts from agent work live in `work-scripts/` — Deno for larger work (`work-scripts/deno/`), bash
for bash-oriented things (`work-scripts/bash/`). Haiku scripts are collocated here too, not in a separate
folder. Full placement rules in `work-scripts/README.md`. The rule that matters most: **read
`work-scripts/INDEX.md` before writing a new script, and append a row to it when you add one** — over time
this becomes the shared set of building blocks agents start from instead of re-creating.

## Diagram maintenance (C4 architecture docs)

`docs/architecture/` holds Simon Brown C4 diagrams for this project (see `docs/architecture/AGENTS.md` for the
diagram conventions). After every plan item lands on `main`, the coordinator spawns a **follow-up docs agent**
(Sonnet-class, docs-only) that:

1. Reads the landed item's diff and decides which C4 diagrams it affects (new service, new container/process,
   changed component boundaries, new external dependency).
2. Updates the affected diagrams **in both formats** (GitHub/Mermaid version and the terminal/glow version) to
   match the new code.
3. Commits as `docs: update C4 diagrams for item NN` on `main` (pull --rebase first) and pushes.

Diagrams must never drift from the code: a reviewer rejects a "diagrams current" claim that was not
re-verified against the landed diff. If an item touches no diagram-relevant surface, the follow-up agent says
so in one line in its commit message (`docs: item NN touches no C4 surface`) and moves on.

## Reflection pass

A reflection pass is a dedicated architectural review of the whole platform at its current state. It runs at
trajectory inflection points (e.g. before starting a new plan or plan phase) — not after every item. Four
phases, in order:

1. **Diagrams**: verify every C4 diagram in `docs/architecture/` matches the actually-landed architecture —
   both the `*.github.md` (Mermaid) and `*.terminal.md` (box-drawing) versions; `render.py --check` must pass.
   Fix any drift found.
2. **Tests**: run the full test suite; report the results (counts, failures).
3. **Queries**: run the DuckDB analysis queries in `scripts/duckdb/` (and the item-23 analysis catalog)
   against real ingested data. Add new queries or adjust stale ones so they reflect the latest architecture.
4. **Verdict**: identify concrete improvements, architectural refactorings, or changes that need to be made —
   with file-level specificity — or declare the architecture good to go, with the evidence for that call.

When it matters, two lenses run concurrently: an architecture/diagram lens (Fable) and a code lens (Opus); a
synthesizer (Fable) then merges both into the final change set.

Outputs: a reflection report plus any diagram/query fixes. The improvement list steers the plans — it becomes
new plan items, not ad-hoc edits.

## File sync protocol

This repo maintains two instruction files: **AGENTS.md** (agent orchestration and repo structure) and
**CLAUDE.md** (repo conventions for the Claude Code CLI). The CLI auto-discovers only CLAUDE.md, never
AGENTS.md — empirically validated in sq-05.

- **AGENTS.md** is the single source of truth for agent orchestration, work protocols, model assignments, and
  repo structure. It is read by human coordinators and agent prompts, never auto-discovered by the CLI.
- **CLAUDE.md** is auto-discovered by the `claude` CLI and defines CLI-facing repo conventions (environment
  setup, branch/worktree etiquette, docs-only session boundaries, commit style). The two files are
  deliberately disjoint — CLAUDE.md is not a summary of AGENTS.md and neither is derivable from the other.
- **Keep the overlap in sync, in both directions.** The files share exactly two topics: branch/worktree
  etiquette and commit style. When either file changes one of those, update the other to match. Everything
  else lives in exactly one file: orchestration protocol, model assignments, and batch rules live only in
  AGENTS.md; environment setup and docs-only session boundaries live only in CLAUDE.md.
- **Do not replace CLAUDE.md with a symlink to AGENTS.md.** A symlink technically works (the CLI opens the
  `CLAUDE.md` path and the filesystem resolves the link — verified 3/3 in review), but it would collapse two
  intentionally different documents, written for different audiences, into one.

## Stopping-point convention

Work proceeds item by item (or quest by quest) and stops at the item the human and coordinator agreed on for
that session. The coordinator reports status on completion: which items landed, which are in review, and what
the next item would be. Do not continue past the agreed stopping point without checking in.
