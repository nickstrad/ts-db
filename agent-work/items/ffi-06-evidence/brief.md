# FFI-06 builder brief

Date: 2026-10-14. Actor: sol-ffi-06. Builder: Codex Sol. Branch: item/ffi-06-evidence. Worktree:
/root/Software/tsdb-work/ffi06. Base: main f2bf1c9 (FFI-05). Concurrent FFI-07 owns disjoint property-test
files. Plan: origin/plan/ffi-implementation:docs/plans/ffi-implementation.md sections 2–5.

Port the read-cost and interrupt PoCs from origin/research/fable-lang-switch to the production
Database/Statement API, preserving JSON metric keys and adding load average. Add the 32-reader deadline
harness through Statement.allAsync with timeoutMs 50. Add a real HTTP two-tenant deadline scenario, point p99
below 50 ms (load scaling per risk 11), HTTP 504 and event-log path nonblocking evidence. Persist
KIND_KEYS.sql.path; update only the affected events golden line. Add a nullable sql_events.path projection and
idempotent ALTER on ingest, plus deadline hits per handler per hour in the analysis catalog. Mark the PoCs
superseded in the script index.

Owns: perf/ffi_read_cost.ts, perf/ffi_interrupt.ts, perf/ffi_cap.ts, perf/README.md (additive),
tests/integration.ts (additive), platform/eventlog/tables.ts, core/eventlog/ddl.ts,
platform/analysis/catalog.ts (one additive query), work-scripts/INDEX.md, core/events.ts (KIND_KEYS.sql.path),
tests/unit/events_test.ts (only affected golden), agent-work/items/ffi-06-evidence/*.

Not owned: binding, deno.json, FFI-07 files, other worktrees. No merge or main edits. Any ownership extension
requires explicit coordinator authorization.

Acceptance: blocking p50 <= 10.2 us and <= node in same run; nonblocking p50 <= 100 us, p99 <= 3000 us; 50
interrupt iterations, p99 <= 20 ms, >= 90 loop ticks per second; 32 deadline cancellations <= 100 ms each.
lint/check/test/test:prop/fmt:check/integration green, logs:ingest and logs:query evidence. Check pgrep for
deno test before each suite and wait for other suites to finish. Known timing flakes are documented, never
hide failures.

One implementation commit: perf: port the FFI harnesses, add the deadline integration scenario and the sql
path column Body contains load/numbers, golden-line change, ALTER note and logs evidence. Separate agent-work:
add FFI-06 brief commit. Push item/ffi-06-evidence only. Log task_completed with validation and SHAs; report
failures honestly. Reviewer is a fresh Claude Opus 5.5 unit, dispatched by the coordinator. Keep the worktree
until coordinator inspection.
