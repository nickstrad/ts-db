# luna-29 findings: item 29 platform user guide

## Work completed

- Added the root `docs.md` guide with the required introduction, process diagram, eight H2 sections,
  configuration link, walkthrough, operational notes, and troubleshooting entries.
- Added `tests/unit/docs_guide_test.ts`. It compares environment-shaped tokens and documented defaults with
  `OPTIONS`, checks analysis names against `platform/analysis/catalog.ts` when available or the plan's item-23
  query list when absent, checks task names against `deno.json`, and verifies the link, no-options-table rule,
  and heading order.
- The item-23 catalog module is absent on this checkout. The test's plan-table fallback is intentional and
  passed against the ten query names in the plan. The guide identifies these as planned catalog names and
  explains that the named-query CLI is not available here.
- The task names `logs:ingest`, `logs:query`, and `logs:sweep` are present in `deno.json`, but
  `scripts/logs.ts` is absent. The guide says this explicitly instead of claiming the commands work.

## Acceptance self-assessment

| Criterion                                           | Result                        | Evidence / limit                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required guide sections and content                 | Pass                          | Eight required H2s, in order; `grep -c '^## ' docs.md` returned `8`. The required install, config, core, SDK, server, backup, observability, and troubleshooting topics are present.                                                                                                         |
| Config and default parity                           | Pass                          | The focused test passed. A temporary `FOO_BAR` mention failed the test with an unknown `OPTIONS` envVar error; a temporary `PORT` default of `8001` failed against `8000`. Both mutations were restored.                                                                                     |
| Catalog parity                                      | Pass with plan fallback       | All ten documented analysis keys matched the plan's item-23 list. The live catalog comparison could not run because `platform/analysis/catalog.ts` does not exist here.                                                                                                                      |
| Deno task, README link, and no copied options table | Pass                          | Focused test verifies task keys in `deno.json`, `README.md#configuration`, and absence of an `Env var` table column.                                                                                                                                                                         |
| TypeScript snippets                                 | Pass for type-checking        | Extracted all three `ts` blocks to temporary repository-root files; all three passed `deno check`. The client example could not be executed against a live server because this sandbox denies local network binds. Temporary files were removed.                                             |
| Shell snippets                                      | Partial / environment blocked | The PATH/version block ran. Starting `deno task serve` failed at `Deno.serve` with `PermissionDenied: Operation not permitted`; therefore health, backup, restore, and live client calls could not be exercised. The S3 block is marked `# not run: needs S3 credentials` on its first line. |
| Unit/core suite                                     | Partial / environment blocked | `deno task test` reported 394 passed, 1 failed, 1 ignored. The sole failure was `tests/unit/server_process_test.ts`, whose `Deno.listen({ hostname: "127.0.0.1", port: 0 })` probe was denied by the sandbox.                                                                                |
| Formatting                                          | Partial                       | `deno fmt --check docs.md tests/unit/docs_guide_test.ts` passed. `deno task fmt:check` fails because the pre-existing, unowned `docs/luna-experiments.md` is not formatted. I left that file untouched to respect the Owns boundary.                                                         |
| Scope                                               | Pass                          | Before adding this requested findings file, `git status --short` showed exactly the two owned guide/test files and no other changes.                                                                                                                                                         |

## Ambiguities and constraints

- Item 29's parity rule refers to an item-23 catalog key, but item 23 has not landed in this checkout. The
  fallback uses the named-query table under §4.3 of the plan until the module exists.
- The spec asks every shell block and client snippet to run against a server, but the sandbox rejects local
  socket binds even when the task uses `-A`. Those run-time criteria remain unverified here; no pass is
  claimed for them.
- The required repository-wide formatter task currently includes an unrelated unformatted file outside this
  item's ownership. The owned files themselves are formatted.
