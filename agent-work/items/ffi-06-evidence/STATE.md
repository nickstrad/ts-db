# FFI-06 final continuation state

2026-10-14 · actor sol-ffi-06-cont2 · branch item/ffi-06-evidence · base f2bf1c9.

Coordinator authorized the local deadline fixture, and the exact patch is applied. Targeted regression 1
passed / 0 failed / 686 filtered out. lint/check/fmt pass (167 lint files, 256 fmt files). Standalone unit
run: 685 passed / 1 failed / 1 ignored; retention size-cap coverage assertion failed. CI rerun: 686 passed / 0
failed / 1 ignored; that same retention test passed without source edits. Standalone and CI property runs each
pass 79 / 0. Integration passes both original checks and FFI-06: 20 HTTP 504, 152 point reads p99 20.06 ms,
ingest 758 lines / 0 rejects, query nonblocking / 20. Previous integration p99 16.44 ms evidence is retained.
See report.md and cont2 logs for full evidence.

CI PASS, exit 0. Strict parity FAIL in all three retained quiet-host runs; absolute and nonblocking budgets
PASS. No benchmark rerun or relaxed gate. Review against the written plan must address parity.

Implementation/evidence commit SHAs are recorded in report.md and the completion event. Push only this branch.
Keep worktree until coordinator inspection; no main/FFI-07/other-worktree edits. Project learning handoff is
committed in report.md; no new reusable script or VM knowledge finding.
