# Project knowledge

Durable ts-db knowledge for future agents and the human: decisions, traps, and terms that survive any single
session. **Start here at session/orientation time**, then open the page relevant to your task.

Markdown only, by human decision (2026-10-11): no RAG index, no `kb` CLI. Sibling projects (`vm-agent`,
`perpetual`) use the nickstrad/kb full-text store; ts-db deliberately stays plain markdown so any agent can
read and edit entries with zero tooling.

## Pages

| Page                                                     | Contents                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| [decisions.md](decisions.md)                             | Architectural decisions with dates and rationale                      |
| [gotchas.md](gotchas.md)                                 | Environment and tooling traps that have bitten agents before          |
| [glossary.md](glossary.md)                               | Project terms: items, batches, side quests, review protocol           |
| [haiku-experiment-record.md](haiku-experiment-record.md) | Preserved 2026-10-10 verdicts from the retired Haiku experiment track |

## Where the project stands

- `agent-work/COORDINATION.md` — the coordinator's live log: what landed, what is in review, what is building.
- `docs/plans/effect-port-and-observability.md` and `docs/plans/multitenancy.md` — the build plans.
- `/root/MUSE_HATCH_README.md` — vm-1 orientation (read once per host).

## Maintenance convention

This folder only works if agents keep it current. Short, enforceable rules:

1. **Read** `index.md` at session/orientation start, before planning new work.
2. **Write** when you learn something durable: after a landing, a review, or a debugging session that taught
   you something another agent would otherwise rediscover. Add it to the right page in the same flow — not
   "later".
3. **Date** new entries (`YYYY-MM-DD`). Undated knowledge rots silently.
4. **Link, don't duplicate.** Plans (`docs/plans/`), architecture (`docs/architecture/`), and findings
   (`docs/haiku-experiments/findings/`) are authoritative for their details; knowledge entries record the
   _why_ and the _trap_, with a link.
5. **Mark superseded entries** with a date and a pointer to the replacement instead of deleting history.
   Delete only what would actively mislead.
6. **Update this index** whenever you add, move, rename, or remove a page.
7. **Never** store credentials, tokens, private runtime data, or unreviewed generated dumps here.
8. Run `deno fmt --check docs/knowledge/` after edits; the repo-wide fmt baseline stays green.
