# FFI-08 fresh Astra delta re-review

Verdict: **PASS**. Reviewed `49bb9cd` (fixup `bba6f7f`) against previously reviewed `caf1efe`, with production
baseline `aa26b27`. Date: 2026-10-14. Actor: `astra-ffi-08-rereview`. Builder: Claude Haiku 5.5; this is a
fresh, independent cross-family review. No product files were changed.

## Numbered defect list

1. None. All three prior NITs are closed; no additional defect found in the inspected item documentation.

## Closure evidence

1. **Tenant boundary:** `docs/knowledge/gotchas.md` explicitly marks the old account superseded, names the FFI
   import and in-process `DocumentReaderClientLive`, and retains the shared-preparation-barrier warning.
   Checked `platform/tenants/routing.ts`'s `Database` import, `platform/layers.ts:449`'s layer composition,
   and `makeDocumentReaderClient` in `platform/document_reader.ts`: query requests execute locally and other
   request kinds delegate to IPC. Each query handler opens a read-only FFI connection. Tenant file and ID
   validation checks absolute paths and parses the ID. `platform/http/handlers.ts` obtains the file from the
   resolved tenant location; `platform/layers.ts:223` documents and implements the shared
   successful-preparation barrier. The corrected account matches these boundaries.
2. **Overhead arithmetic:** independently recomputed `(ffi / node - 1) * 100` from the ADR rows:
   `(7.35 / 6.93)` gives 6.060606%, `(7.64 / 7.21)` gives 5.963939%, and `(7.57 / 7.10)` gives 6.619718%.
   Approximately 6.0–6.6% is accurate in both ADR 0008 and `docs/knowledge/decisions.md`. Amended bounds are
   10.009, 10.373 and 10.230 microseconds, matching the rounded table values.
3. **Gate characterization:** ADR 0008 now separates the same-run relative parity bound
   `blocking p50 <= 1.3 * node p50 + 1 us` from the fixed budgets. Checked assertions in
   `perf/ffi_read_cost.ts:69`–75 (10.2 us blocking; 100/3000 us nonblocking), `perf/ffi_interrupt.ts:61`–62
   (20 ms p99; at least 90 ticks), `perf/ffi_cap.ts:42` (100 ms), and `tests/integration.ts` (flat 50 ms
   competing point-read p99). Risk 21 remains an explicit follow-up in the ADR and plan; the fix does not
   claim that load-sensitive gates have already been normalized.

## Scope, fresh-eyes checks and validation

- `git diff --name-only caf1efe 49bb9cd` contains exactly four paths: the item brief, ADR 0008,
  `docs/knowledge/decisions.md`, and `docs/knowledge/gotchas.md`. This satisfies the requested docs-only delta
  scope. `git diff --quiet aa26b27 49bb9cd -- platform core perf tests` succeeds: the inspected runtime and
  gate code is identical to the baseline.
- Re-read the new ADR and usage-doc changes against the classifier, configuration validation, document reader,
  routing, and layer wiring. The exact classifier excludes aggregates from bounded selects; deadlines default
  to 5000 ms and grace to 1000 ms, with deadline below reader timeout. Binding code confirms the 3.37 minimum,
  FULLMUTEX, DQS-off and foreign-key defaults, and Apple arm64 refusal. No further contradiction found in
  those claims. The previous report's broader C4 audit remains applicable: the fixup changes neither diagrams
  nor runtime code. This review also inspected the item's C4 delta, which changes audit annotations rather
  than elements or relationships.
- `deno fmt --check docs/ README.md docs.md`: **PASS**, 57 files.
- `deno task fmt:check`: **PASS**, 260 files.
- `python3 docs/architecture/diagrams/render.py --check`: **PASS**, all diagrams current.
- No full suite, focused tests, or performance reruns were run, as requested. This verdict checks the
  documentation and recorded measurement arithmetic, not a new performance result.

## Existing hand-offs and learning assessment

The first report's separate hand-offs remain: the stale percentage in `perf/README.md`, the config option
description and its README mirror, reciprocal pointers in older ADRs, and integration of the separately owned
planned C4 index. None is introduced by this fixup or requires expanding its ownership. The corrected boundary
and gate distinctions are already preserved in the knowledge pages and ADR; this committed report preserves
closure evidence. No new VM knowledge or reusable script was produced.

PASS does **not** authorize landing: Nick's explicit approval is still required. The review worktree is
retained for coordinator inspection and cleanup. No other worktree or branch was modified.
