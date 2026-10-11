# Agent event schema

Immutable Markdown files, one event per file. The first ten lines are fixed:

````markdown
<!-- deno-fmt-ignore-file -->
# Agent event

```text
timestamp: 2026-10-11T16:20:31Z
actor: codex-mt04
branch: item/mt04-router
type: task_started
summary: MT-04 router implementation started
```
````

An optional blank line and Markdown detail body follow. The first-line formatter directive keeps published
events immutable when Deno formats the repository. This is a plain-text header, **not YAML**: colons, quotes,
and Markdown in values are literal. Readers parse only lines 5–9; detail may contain header-like text.
Required fields:

- `timestamp`: UTC RFC 3339, seconds, emitted by the helper.
- `actor`: stable agent/tmux/session identity; 1–80 ASCII letters, digits, `.`, `_`, `-`, starting with a
  letter or digit. Prefer `--actor` or exported `AGENT_ACTOR`; fallback `session-<pid>` identifies only this
  invocation.
- `branch`: nonempty branch label with no control characters. Explicit so reviewers can name the branch under
  review; detached work can use `detached-<sha>`.
- `type`: exactly one of the six values below.
- `summary`: one nonblank line, no control characters. Include the task/item ID for correlation.

| Type              | Meaning and detail convention                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `task_started`    | Actor begins or resumes named work.                                                                |
| `task_completed`  | Work finished; include result, validation, and commit SHA when applicable. Does not imply landing. |
| `landed`          | Coordinator verified merge/push; include destination branch and landed SHA.                        |
| `review_verdict`  | Summary begins with PASS, NITS, or FAIL; detail names reviewed SHA and findings.                   |
| `blocker`         | Work cannot proceed; name affected task, cause, and needed unblock action.                         |
| `decision_needed` | Human/coordinator choice needed; name question, options, and decision owner.                       |

This list is closed. Correct mistakes or report resolutions in a new event (for example `task_started` after
an unblock, or `task_completed` for a decision task); reference the earlier event filename in detail. Never
edit, delete, or rename a published event. Events are reports, not locks or proof of approval. Never record
secrets or sensitive payloads.

Filenames: `YYYY-MM-DDTHH-MM-SSZ-<actor>-<random>.md`. Filename is the event ID; random suffix breaks
collisions, not ties in causal ordering. See [design and operating protocols](../event-log.md) for the shared
live inbox, archive, write/read commands, and status polling.
