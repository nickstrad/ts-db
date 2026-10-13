# Agent orchestration protocol for ts-db

This file is the coordination contract for agents working on this repo. It covers the plan in
[`docs/plans/effect-port-and-observability.md`](docs/plans/effect-port-and-observability.md) and the
side-quest track in [`docs/side-quests.md`](docs/side-quests.md). For repo conventions (how to run things,
style), see `CLAUDE.md`.

## Fresh-agent lifecycle (every unit of work)

Every build, review, repair/fixup, documentation follow-up, side quest, and other bounded task is a separate
unit of work. The coordinator must dispatch each unit to a **newly spawned subagent with fresh context** in
its **own git worktree**. A completed subagent session must never receive another unit, even on the same item
or branch. There are no convenience exceptions. Supply an explicit brief and committed references; do not
carry a previous unit's conversational context into the new agent.

1. **Start**: spawn a new agent, assign its branch/worktree and authorized files, and read the required
   orientation and shared event log. Give this fresh unit its own stable event actor ID.
2. **Complete and commit**: perform the assigned work, validate it, and commit every change. A read-only
   review or investigation records its verdict/findings in an authorized committed report; publishing an event
   alone does not preserve the work in Git.
3. **Preserve learning**: assess the completed work for durable `docs/knowledge/` material and reusable
   scripts or information useful to other agents. Commit useful findings and scripts, following the knowledge
   and work-script conventions below; report the assessment even when nothing needs preserving. Ownership
   constraints still apply: hand findings outside the unit's `Owns` set to the coordinator or a newly spawned
   agent authorized for those files. Ensure that handoff is committed before closing the unit; never expand a
   builder's or side-quest agent's ownership to satisfy this step.
4. **Close**: report the commit SHA(s), validation, learning assessment, and any handoff; after coordinator
   inspection, clean up the unit's own worktree. Preserve commits and required handoffs before removal; never
   clean another active agent's worktree. The coordinator completes removal if the agent's session has ended.
5. **Next unit**: spawn another new agent with fresh context and its own worktree. Continuing after an
   interruption is permitted only within the same still-active unit; completion ends session eligibility.

The coordinator assigns, inspects, and lands work under the existing approval rules; fresh agents do the
units. Separate knowledge/script preservation commits do not replace the one-item implementation commit.

## Execution modes (hybrid)

Work runs in one of two modes. The mode never changes the fresh-agent lifecycle above: fresh context per unit, commit, knowledge/script preservation, worktree cleanup.

1. **Headless runs (default for item work).** Builds, reviews, fixups, and side quests run as non-interactive agent processes launched by the coordinator: the brief is a file passed to the run (`claude -p`, `codex exec`, or `muse exec --prompt-file`), the run gets its own branch/worktree, the brief names its permission profile and acceptance checks up front, and the coordinator records the run's exit status and saves its machine-readable output (JSON event stream or transcript) with the item checkpoint. No interactive session is created or kept for item work, and no work waits on anyone watching a terminal.
2. **Long-lived interactive sessions (coordinators and planners only).** A small number of persistent sessions (e.g. in tmux) are reserved for roles whose value is accumulated context across items: plan authoring, research synthesis, cross-item coordination. They dispatch headless runs and judge results; they do not do item work themselves.
3. **Coordination is files, in both modes.** Briefs/claims, `agent-work/COORDINATION.md`, `STATE.md`, and the shared event log are the coordination channel. Messages between agents travel as committed files or new headless runs, never as text typed into another agent's terminal session.
4. **Exceptions are explicit.** Interactive item work (live debugging, joint exploration with the user) is allowed when the brief names it and says why; it is never the default.

## Build protocol (plan items)

1. **Brief**: the coordinator takes one item from the plan (its Owns/Reads sets, model assignment, work steps,
   acceptance criteria) and hands it to a newly spawned builder subagent with fresh context.
2. **Build**: the builder works on branch `item/NN-slug`, in its own git worktree (coordinator worktrees live
   under `/root/Software/tsdb-work/` — other agents must not touch those paths or branches while work is in
   flight). The builder edits only files in its item's `Owns` set and may read, but not edit, files in its
   `Reads` set.
3. **Commit**: one item = one commit on that branch. Subject line: `<area>: <imperative summary>`.
4. **Review**: a newly spawned Opus reviewer (`reviewer-opus-high`) in its own worktree reviews the diff
   against `main` against the plan item's acceptance criteria and returns a verdict: **PASS**, **NITS**, or
   **FAIL**. Review is not a separate plan item — every item gets one regardless of which model built it.
5. **Land**: on PASS, the coordinator merges the branch to `main` and pushes. NITS gets a fixup commit and a
   re-review of the delta by a new reviewer; FAIL goes to a new repair agent with the defect list. Every
   repair/fixup and every review follows the fresh-agent lifecycle in its own worktree.

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
- **Haiku** (never ≤4.5) — side quests **only**, tracked in `docs/side-quests.md`. Haiku never lands work to
  `main` without both an Opus review (PASS) and explicit human approval — a PASS alone is not sufficient
  authorization to merge. Haiku side-quest work happens on `haiku/sq-NN` branches, never on an `item/NN-slug`
  branch or worktree.

Every item, regardless of model, gets the same Opus review pass described above.

## Model duality

Builders may use `claude --model opus|sonnet|haiku` or `codex exec --model <full-id>`. The short OpenAI names
below are plan labels; pass the full verified ID to Codex. The top Anthropic tier is **Opus 5.5**.

| Repo tier                       | Claude CLI alias                   | OpenAI label | Codex model ID |
| ------------------------------- | ---------------------------------- | ------------ | -------------- |
| Top: hard correctness, reviews  | `opus` (Opus 5.5)                  | astra        | `gpt-6-astra`  |
| Middle: bounded mechanical work | `sonnet`                           | sol          | `gpt-6.1-sol`  |
| Fast/cheap, run on high effort  | `haiku` (= Haiku ≥5.5, never ≤4.5) | luna         | `gpt-6-luna`   |

IDs verified in `/root/.codex/models_cache.json`, fetched 2026-10-11 02:23 UTC (CLI 0.161.0). No OpenAI ID
deviations were found. This is the repo's standing dispatch correspondence.

Match the task's intelligence tier; either family is acceptable within that tier. This section permits astra
where the build protocol or a plan calls for Opus 5.5, including an independent top-tier review (a different
reviewer from the builder), and sol where it calls for Sonnet. Luna is the Haiku-tier OpenAI label and always
runs on high effort; the `haiku` alias resolves to `claude-haiku-5-5` (verified 2026-10-11 via
`--output-format json`); if the alias ever drifts to Haiku ≤4.5, pin with a ≥5.5 model ID (e.g.
`claude --model claude-haiku-5-5`). Haiku ≤4.5 must never be used. The mapping above is the standing one.
Independent reviews stay top-tier (Opus 5.5 or astra). Model names alone never authorize work outside an
item's ownership. This orchestration policy lives only here; `CLAUDE.md` needs no change.

## Side-quest protocol

Side quests are small, bounded investigations (survey a library's patterns, measure a baseline, compare output
formats) that are read-only or scratch-only against the product tree — they must never modify plan item files
(`core/`, `platform/`, `sdk/`, `app/`, `tests/`, `scripts/`, `perf/`, `deno.json`).

1. The main agent appends new quests to the board table in `docs/side-quests.md` (id, question, why it
   matters, done-criteria).
2. A newly spawned Haiku subagent with fresh context and its own worktree claims one quest, investigates,
   commits its findings, and writes them to exactly `docs/haiku-experiments/findings/<quest-id>.md` — a unique
   path per quest, so concurrent Haiku runs never collide on a shared-file edit. A Haiku agent does not edit
   the board itself, any other quest's findings file, or `MEMORY.md`.
3. The main agent updates the quest's status in the board and commits the status change together with the new
   findings file.

## Work scripts

Reusable scripts from agent work live in `work-scripts/` — Deno for larger work (`work-scripts/deno/`), bash
for bash-oriented things (`work-scripts/bash/`). Haiku scripts are collocated here too, not in a separate
folder. Full placement rules in `work-scripts/README.md`. The rule that matters most: **read
`work-scripts/INDEX.md` before writing a new script, and append a row to it when you add one** — over time
this becomes the shared set of building blocks agents start from instead of re-creating.

## Knowledge

`docs/knowledge/` is the project's durable memory — decisions, gotchas, glossary — plain markdown with an
`index.md`. **Read `docs/knowledge/index.md` at session/orientation start**, before planning new work.
**Update it when you learn something durable**: a landing, a decision, a debugging session that taught you
something another agent would otherwise rediscover. Date new entries (`YYYY-MM-DD`); link, don't duplicate;
mark superseded entries instead of deleting history. Markdown only — never the `kb` CLI.

## Diagram maintenance (C4 architecture docs)

`docs/architecture/` holds Simon Brown C4 diagrams for this project (see `docs/architecture/AGENTS.md` for the
diagram conventions). After every plan item lands on `main`, the coordinator spawns a **follow-up docs agent**
(Sonnet-class, docs-only) with fresh context in its own branch/worktree based on current `main` that:

1. Reads the landed item's diff and decides which C4 diagrams it affects (new service, new container/process,
   changed component boundaries, new external dependency).
2. Updates the affected diagrams **in both formats** (GitHub/Mermaid version and the terminal/glow version) to
   match the new code.
3. Commits as `docs: update C4 diagrams for item NN` on its assigned branch, completes the learning
   assessment, and reports for coordinator inspection and landing. It cleans its worktree after inspection; it
   does not edit directly on `main`.

Diagrams must never drift from the code: a reviewer rejects a "diagrams current" claim that was not
re-verified against the landed diff. If an item touches no diagram-relevant surface, the follow-up agent says
so in its committed assessment (`docs: item NN touches no C4 surface`) and closes that unit.

## Reflection pass

A reflection pass is a dedicated architectural review of the whole platform at its current state. It runs at
trajectory inflection points (e.g. before starting a new plan or plan phase) — not after every item. Four
phases, in order:

1. **Diagrams & usage docs**: verify every C4 diagram in `docs/architecture/` matches the actually-landed
   architecture — both the `*.github.md` (Mermaid) and `*.terminal.md` (box-drawing) versions;
   `render.py --check` must pass. Fix any drift found. Update the usage docs alongside the diagrams — root
   `docs.md`, the README’s Configuration/usage sections, and any other user-facing docs — so they describe the
   landed behavior, not the plan.
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

## Shared agent event log

Every agent/session reads the shared log at task start and reports task starts/completions, landings, review
verdicts, blockers, and decisions needed using `work-scripts/bash/log-event.sh`. Follow
[the write/read and archive protocols](agent-work/event-log.md) and the closed
[event schema](agent-work/events/README.md). Use a distinct actor ID per fresh unit, stable for that unit
only, and put the item/task ID in summaries. Do not reuse a completed session or its actor for a new unit. The
shared live inbox is under Git's common directory, visible across linked worktrees; the tracked
`agent-work/events/` directory is its batched archive. Coordinators poll the live inbox for status, including
20-minute updates. Events supplement the coordination summary and never grant merge authority.
