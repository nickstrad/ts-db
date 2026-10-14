# FFI-08 independent Astra review

Verdict: **NITS**. Reviewed `caf1efe` (implementation `6337a4e`, step-0 merge `c6c36f4`) against code baseline
`aa26b27`. Reviewer actor: `astra-ffi-08-review`. Date: 2026-10-14. Builder: Claude Haiku 5.5; this is an
independent cross-family review. No implementation or documentation fixes were made.

The cutover documentation and diagrams substantially match the landed implementation. Three small accuracy
corrections remain. This is not a PASS or landing authorization: a fresh delta review must pass, and Nick must
explicitly approve landing.

## Numbered defects

1. **Stale current guidance in an owned knowledge page.** `docs/knowledge/gotchas.md:124` says tenant queries
   carry their location over private IPC, and `:125` says `platform/tenants/routing.ts` loads `node:sqlite`.
   Neither describes the current server. Routing imports the FFI binding; document queries are intercepted
   in-process by `DocumentReaderClientLive` (`platform/layers.ts:449` and `platform/document_reader.ts`),
   while ingest/analysis go to the child. The entry is dated, but its imperative guidance has no superseded
   marker or local correction. This fails the requested historical/contrast-only audit and can misdirect
   future agents about the process boundary. Reproduce: `grep -n 'node:sqlite' docs/knowledge/gotchas.md`,
   then read routing's imports and the layer composition. Mark the old account superseded and state the
   current FFI/in-process boundary, preserving its valid shared-preparation-barrier warning. Unlike the old
   ADR hand-off below, this file is in FFI-08's Owns set.

2. **The stated overhead does not match the table.** `docs/adr/0008-statement-execution-via-ffi.md:117` says
   all three quiet runs fail strict parity by “3.5 to 6 %”; `docs/knowledge/decisions.md:19` repeats that
   range. From the ADR's own rows, the overheads are **6.0606%, 5.9639%, and 6.6197%**: compute
   `(ffi_p50 / node_p50 - 1) * 100` for `(7.35, 6.93)`, `(7.64, 7.21)`, and `(7.57, 7.10)`. Say approximately
   **6.0–6.6%** for these runs, or identify different evidence supporting the other range. The values and
   amended PASS outcomes are correct; this is a prose arithmetic error. It matters because the ADR is the
   permanent account of why strict parity was amended. `perf/README.md:172` has the same inherited error;
   correcting that file is a coordinator hand-off, not permission for the docs builder to edit `perf/`.

3. **The ADR calls absolute timing gates same-run ratios.** `docs/adr/0008-statement-execution-via-ffi.md:106`
   says “Gates are same-run ratios”, and `:177` repeats “Gates are ratios” for risk 21. The amended parity
   gate is a same-run relative bound plus 1 µs, but the other gates are fixed: `perf/ffi_read_cost.ts:69` uses
   10.2 µs, `:74` and `:75` use 100/3000 µs; `perf/ffi_interrupt.ts:61` and `:62` use 20 ms and 90 ticks;
   `perf/ffi_cap.ts:42` uses 100 ms. The HTTP integration budget is also a flat 50 ms. Reproduce by reading
   those assertions. Distinguish the relative parity bound from the absolute budgets, with host load recorded
   for both. The current wording incorrectly implies that the load-sensitive gates have already been
   normalized; risk 21 is explicitly a follow-up to address that remaining fragility.

## Validation and acceptance audit

- **Scope:** `git diff --name-only aa26b27 caf1efe` lists 16 files, all within `docs/**`, `README.md`,
  `docs.md`, or `agent-work/items/ffi-08-docs/`. No changes to `platform/`, `core/`, `sdk/`, `app/`, `tests/`,
  `scripts/`, `perf/`, or `deno.json`. Consequently the inspected production code is identical to `aa26b27`.
- **Checks run:** `python3 docs/architecture/diagrams/render.py --check` passed (“all diagrams current”);
  `deno fmt --check docs/ README.md docs.md` passed (57 files); `deno task fmt:check` passed (260 files).
  `deno test -A tests/unit/config_test.ts tests/unit/docs_guide_test.ts tests/unit/boundaries_test.ts` passed
  **51 tests, 0 failures** (37 config, 6 guide, 8 boundaries). The requested process check found no matching
  active Deno test/task or Muse process before execution. No full suite or performance rerun was started; this
  review checks the recorded measurement evidence, not a new performance claim.
- **Code accuracy:** verified classifier's exact `_id` equality/no-aggregate condition; 5000 ms deadline and
  1000 ms grace defaults; finite-positive validation and deadline below reader timeout; 504 mapping;
  ConnectionGate's watchdog, poisoning, queued statements and close-after-settlement; FULLMUTEX opens, checked
  DQS-off calls and `foreign_keys=ON`; darwin/aarch64 refusal; per-path library caching and default
  distro-path-first resolution. `MIN_VERSION_NUMBER = 3_037_000` confirms the 3.37 correction. Read the
  binding's full-length text fallback, scoped async close and cache, integer binding branches, and the
  property test's explicit `-0` and NaN assertions. These match the new claims.
- **Observability and troubleshooting:** checked the startup library event and `StorageError` mapping in
  `platform/layers.ts`; SQL path emission in writer/document reader, JSONL key in `core/events.ts`, nullable
  column and idempotent ALTER in `core/eventlog/ddl.ts`, projection in `platform/eventlog/tables.ts`, and
  deadline catalog query. README's config mirror and guide's named query/task references pass their dedicated
  tests.
- **ADR:** 0008 is correctly numbered and indexed; 0006/0007 already exist. Decision, two-copies rule,
  threading/lifetime model, alternatives and risks 15–22 are present. Risk 23 is appropriately treated as
  agent tooling rather than architecture. The measurement table, loads, interrupt/cap results and three HTTP
  p99 values match `perf/README.md`; the FFI-04 improvement matches merge `51a5283`'s message. The formula is
  exactly `1.3 * node_p50 + 1 µs` in the ADR and harness. Verified Nick's 2026-10-13 ~23:03 CDT ruling by
  reading `/root/fable-ffi06-ruling-nick.md`; plan §4 FFI-06 and risk 19 preserve the full provenance. The ADR
  cites the plan and numbered risk register rather than repeating the absolute ruling-file path. The
  arithmetic and gate-characterization nits above remain.
- **Plan:** compared the imported plan at `c6c36f4` with `6337a4e`, normalizing whitespace to inspect semantic
  changes. Changes are status, the 3.37 correction, and the ADR-number correction, plus table formatting; no
  design or acceptance gate was silently changed. §3 records the correct landed SHAs: `6f5c4d0`, `398be14`,
  `182e85d`, `51a5283`, `702c354`, `f2bf1c9`, `14ef53c`, `5c2a499`. FFI-08 correctly remains built/landing
  pending. Historical baseline and work-step language is retained as plan history; it is not an assertion of
  today's module graph.
- **Driver wording audit:** the requested recursive grep produces 98 matching lines. Current usage docs and
  diagrams use FFI or explicit comparison wording. Historical plans, experiments and older ADRs retain
  old-driver references. The unmarked knowledge instruction in defect 1 needs correction; old ADR pointers are
  the separate authorized-scope hand-off below.

## Independent C4 verification

I checked the boxes, relationships and runtime notes against implementation, not just the builder's stamp.
Both touched pairs carry `aa26b27`; the generator checks both complete Markdown formats against their Python
sources, including matching relationship keys and prose. No element/edge change is needed for FFI-08.

For the server component's 38 relationships, checked HTTP/app/auth/tenant dispatch in
`platform/http/{router,handlers,auth}.ts`, auth service and registry wiring; tenant preparation and library
opens in `platform/tenants/routing.ts`; writer cache/serialization and ConnectionGate in `platform/sqlite.ts`;
local document dispatch, fresh read-only transactions, classifier and 32-permit cap in
`platform/document_reader.ts`; startup/config/IdGen/service ordering in `platform/layers.ts`; backup snapshot
verification/publication in `platform/backup.ts`; and lifecycle timers, child supervision and shutdown in
`platform/server.ts` and `platform/ipc.ts`. Logging edges agree with sink calls and the `platform/logging/`
implementation. The new SQL path note agrees with the event-log code identified above.

For the request-path container's seven relationships, verified typed HTTP entry, JSONL child IPC, server-only
application SQLite FFI access, central Postgres registry/auth access, tenant/auth and migration CLI
entrypoints, and backup object publication. `docker-compose.yml` pins Postgres 17. The module-boundary tests
independently confirm neither process reaches `node:sqlite` and the SQLite side does not import DuckDB. The
reader remains responsible for event-log ingest/analysis, with no new lane/process introduced. FFI-06's
harnesses and FFI-07's properties add no runtime component.

## Hand-offs, separate from defects

- **Config description:** legitimate code-owned follow-up. `platform/config.ts:326` still says “HTTP 504 once
  FFI-05 lands”; the README Configuration row must mirror it exactly and its test passes. A separately
  authorized change should update the option description and README together. This is not a defect of the
  builder's decision to preserve the mirror.
- **Missing planned C4 index:** legitimate branch-integration follow-up. `docs/plans/ffi/README.md` is absent
  from both `aa26b27` and `origin/plan/ffi-implementation`; it exists on `origin/docs/ffi-c4` (commit
  `04fe870`). Updating its status belongs with bringing that separately owned material forward.
- **Older ADRs 0004/0005:** legitimate ownership hand-off. They retain historical driver statements; ADR 0008
  explicitly supersedes those statements while retaining their decisions. Add reciprocal pointers in a
  separately authorized docs unit; do not expand this builder's Owns set.
- **Perf source prose:** coordinator should assign the `perf/README.md` percentage correction noted in defect
  2 to an owner permitted to edit `perf/`. Existing measurements and gate assertions need no change.

## Learning assessment and closeout

No new VM/environment fact or reusable script was produced. Project findings worth preserving are the stale
knowledge entry and the distinction between measured relative overhead and absolute timing budgets; they are
preserved in this committed report and handed to the coordinator for the authorized repair unit. No edits
outside `agent-work/` were made. The review worktree remains for coordinator inspection and cleanup; no other
worktree or branch was changed.
