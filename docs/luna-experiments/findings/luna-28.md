# luna-28 findings

Item: luna-28 (plan item 28 — self-contained runnable demos)\
Branch: `luna/28-demos`\
Date: 2026-10-11\
Model used: `gpt-6-luna`, high effort

## Files built or changed

- `demos/documents/main.ts` — repaired the prior documents demo so it type-checks, cleans up its server, and
  compares equivalent fixture values across both layouts.
- `demos/backup-restore/main.ts` — repaired the prior backup demo's Effect APIs and asynchronous file
  operations; it now type-checks and completes backup/restore.
- `demos/observability/main.ts` — added the traced workload, deliberate 409 and 404, bounded ingest/trace
  retry, four analysis calls, table output, and log-tree output.
- `demos/README.md` — documented all three demos and their commands, behavior, touched features/queries,
  expected output tails, and the frozen `deno.json` constraint.
- `docs/luna-experiments/findings/luna-28.md` — this acceptance record.

## Acceptance checklist

| Criterion                                                                     | Result | Evidence                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents demo exits 0 and ends with its success line                         | PASS   | Individual run exit 0; final lines were `Columns and JSON layouts agree ...` and `DEMO OK: documents`. It also passed in the concurrent run.                                                                                                                                                 |
| Backup/restore demo exits 0 and ends with its success line                    | PASS   | Individual run exit 0; final line `DEMO OK: backup-restore`. Restore reported version 3 versus post-backup version 4. It also passed concurrently.                                                                                                                                           |
| Observability demo exits 0 and ends with its success line                     | FAIL   | It exits 1 after the 10-second retry deadline. Last error is HTTP 500 `IngestError`; `platform/reader.ts` still returns `event-log ingest is not available`. No `DEMO OK: observability` is printed.                                                                                         |
| All three demos pass concurrently                                             | FAIL   | Concurrent run: documents exit 0, backup/restore exit 0, observability exit 1 with the same unavailable-ingest failure.                                                                                                                                                                      |
| Demos assert behavior, and a flipped expectation fails without success output | PASS   | Temporarily changed the documents `getGame` assertion from non-null to null. Run exited 1 with `ASSERTION FAILED: columns: getGame returns newly created game`; no `DEMO OK` appeared. Restored the assertion afterward.                                                                     |
| No repo-root `./data`, `./logs`, or `./object-store` created                  | PASS   | `test ! -e` succeeded for all three paths after individual and concurrent runs.                                                                                                                                                                                                              |
| No leaked `platform/server.ts` or `platform/reader.ts` process                | PASS   | `pgrep -af '[p]latform/(server                                                                                                                                                                                                                                                               |
| No platform imports in demos                                                  | PASS   | `grep -rnE 'from "[^"]*platform/' demos/` returned no output.                                                                                                                                                                                                                                |
| No cross-demo imports                                                         | PASS   | `rg -n 'from ["\x27][^"\x27]*demos/' demos` returned no output.                                                                                                                                                                                                                              |
| `deno check demos/*/main.ts`                                                  | PASS   | Checked all three main files successfully.                                                                                                                                                                                                                                                   |
| `deno task fmt:check`                                                         | FAIL   | The repository-wide command reports three pre-existing unformatted files: `AGENTS.md`, `docs/luna-experiments.md`, and `docs/plans/effect-port-and-observability.md`. They are outside the authorized edit scope; `deno fmt --check demos docs/luna-experiments/findings/luna-28.md` passes. |
| `deno task lint`                                                              | PASS   | `Checked 97 files`, exit 0.                                                                                                                                                                                                                                                                  |
| Worktree changes stay within `demos/` plus this findings file                 | PASS   | Final status check is recorded before commit; no files outside those paths were edited. `deno.json` is unchanged.                                                                                                                                                                            |
| `git diff --name-only origin/main..HEAD` is limited to demos and findings     | PASS   | Verified after the requested commit; output lists only `demos/` and `docs/luna-experiments/findings/luna-28.md`.                                                                                                                                                                             |

## Self-assessment

Scope discipline was good: all code and documentation edits stayed in `demos/`, plus this requested findings
file. I did not edit `deno.json` or platform files, and did not merge to `main`.

The two earlier demos needed meaningful repairs rather than simple review. They used a `tryPromise` signature
rejected by the installed Effect version; the documents demo also compared different player names across
layouts and had malformed Effect result assertions. The backup demo used `await` inside a synchronous Effect
generator and passed a synchronous value to `tryPromise`. These failures were found by the requested type
check and runtime runs, then fixed and verified.

Observability is not demonstrated end to end on this branch. The demo's workload and bounded retry are
implemented, but the checked-out reader has no event-log ingest implementation and returns `IngestError`
immediately. No analysis catalog exists in this checkout either, so table results, the 409/404 query rows, and
the printed log tree could not be exercised. I did not work around this by changing platform-owned files. The
concurrent acceptance criterion consequently fails.

The repo-wide formatter check also remains red because `docs/luna-experiments.md` has unrelated existing
formatting drift. Formatting that file would violate the requested edit scope.

## Prior-demo fixes

- `documents`: corrected Effect APIs and resource finalization; removed invalid uses of `await`; fixed the
  `Effect.gen`/`yield*` result handling; made both layouts use matching player values; retained the typed
  `ConflictError` adaptation and validation error assertion.
- `backup-restore`: corrected Effect APIs and cleanup finalizers; changed the synchronous server setup to
  `Effect.try`; moved reads and SHA-256 computation into Effects rather than using `await` inside
  `Effect.gen`.
- `README`: removed a stale note claiming the demo files were only target behavior, clarified that the success
  line follows assertions and cleanup follows via the scope, and aligned the retry description with the
  trace-query condition.

## Spec ambiguities and limitations

- The spec says to pass the trace id as a parameter but does not name the JSON key; the demo uses
  `{ traceId }`, following the route/API's camel-case request shape and the SQL catalog's `$trace_id` naming
  convention.
- The exact row shape for `error-rate-by-handler` is not present in this checkout. The demo checks that
  serialized rows contain both HTTP status values, 409 and 404, as required, but could not validate this
  against the missing catalog implementation.
- The acceptance criterion says `git status --porcelain` is unchanged after runs, while the demos and findings
  are the intended branch changes. Runtime side effects were checked separately: only the authorized source
  paths are changed, no root data directories or server/reader processes remain.

No merge to `main` was performed. The branch is retained for review.
